"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface FlightInfo {
  icao24: string;
  callsign: string;
  origin_country: string;
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number | null;
  heading: number | null;
  vertical_rate: number | null;
  on_ground: boolean;
  bearing: number;
  distance: number;
  elevation: number;
}

// Normalize angle to 0-360
function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

// Calculate angular difference accounting for wraparound
function angleDiff(a: number, b: number): number {
  const diff = normalizeAngle(a - b);
  return diff > 180 ? diff - 360 : diff;
}

// Smoothing for compass readings
const SMOOTHING_FACTOR = 0.3;

function smoothAngle(current: number | null, target: number, factor: number): number {
  if (current === null) return target;
  let diff = target - current;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return normalizeAngle(current + diff * factor);
}

// Format altitude nicely
function formatAltitude(meters: number): string {
  const feet = Math.round(meters * 3.28084);
  if (feet >= 10000) {
    return `FL${Math.round(feet / 100)}`;
  }
  return `${feet.toLocaleString()} ft`;
}

// Format speed
function formatSpeed(mps: number | null): string {
  if (mps === null) return "—";
  const knots = Math.round(mps * 1.944);
  return `${knots} kts`;
}

// Format distance
function formatDistance(km: number): string {
  if (km < 1) {
    return `${Math.round(km * 1000)} m`;
  }
  return `${km.toFixed(1)} km`;
}

// Direction from bearing
function bearingToDirection(bearing: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(normalizeAngle(bearing) / 45) % 8;
  return directions[index];
}

export default function Home() {
  const [location, setLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [flights, setFlights] = useState<FlightInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  const [compassHeading, setCompassHeading] = useState<number | null>(null);
  const [deviceTilt, setDeviceTilt] = useState<number | null>(null);
  const [permissionState, setPermissionState] = useState<"prompt" | "granted" | "denied" | "unsupported">("prompt");
  const [isTracking, setIsTracking] = useState(false);

  const [matchedFlight, setMatchedFlight] = useState<FlightInfo | null>(null);
  const [selectedFlight, setSelectedFlight] = useState<FlightInfo | null>(null);

  const lastHeadingRef = useRef<number | null>(null);
  const lastTiltRef = useRef<number | null>(null);

  // Get user location
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation not supported");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      (err) => {
        setLocationError(err.message);
      },
      { enableHighAccuracy: true }
    );
  }, []);

  // Fetch flights when we have location
  const fetchFlights = useCallback(async () => {
    if (!location) return;

    setIsLoading(true);
    try {
      const res = await fetch(`/api/flights?lat=${location.lat}&lon=${location.lon}&radius=150`);
      const data = await res.json();
      if (data.flights) {
        setFlights(data.flights);
        setLastUpdate(Date.now());
      }
    } catch (err) {
      console.error("Failed to fetch flights:", err);
    } finally {
      setIsLoading(false);
    }
  }, [location]);

  // Initial fetch and periodic refresh
  useEffect(() => {
    if (location) {
      fetchFlights();
      const interval = setInterval(fetchFlights, 10000); // Refresh every 10s
      return () => clearInterval(interval);
    }
  }, [location, fetchFlights]);

  // Request device orientation permission
  const requestPermission = useCallback(async () => {
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };

    if (typeof DOE.requestPermission === "function") {
      try {
        const permission = await DOE.requestPermission();
        setPermissionState(permission);
        if (permission === "granted") {
          setIsTracking(true);
        }
      } catch {
        setPermissionState("denied");
      }
    } else {
      setPermissionState("granted");
      setIsTracking(true);
    }
  }, []);

  // Listen for device orientation
  useEffect(() => {
    if (!isTracking) {
      lastHeadingRef.current = null;
      lastTiltRef.current = null;
      return;
    }

    const handleOrientation = (event: DeviceOrientationEvent) => {
      const webkitEvent = event as DeviceOrientationEvent & { webkitCompassHeading?: number };

      let rawHeading: number | null = null;

      if (webkitEvent.webkitCompassHeading !== undefined) {
        rawHeading = webkitEvent.webkitCompassHeading;
      } else if (event.alpha !== null) {
        rawHeading = normalizeAngle(360 - event.alpha);
      }

      if (rawHeading !== null) {
        const smoothed = smoothAngle(lastHeadingRef.current, rawHeading, SMOOTHING_FACTOR);
        lastHeadingRef.current = smoothed;
        setCompassHeading(smoothed);
      }

      if (event.beta !== null) {
        const rawTilt = Math.max(0, Math.min(90, 90 - event.beta));
        const smoothed = lastTiltRef.current === null
          ? rawTilt
          : lastTiltRef.current + (rawTilt - lastTiltRef.current) * SMOOTHING_FACTOR;
        lastTiltRef.current = smoothed;
        setDeviceTilt(smoothed);
      }
    };

    window.addEventListener("deviceorientation", handleOrientation, true);
    return () => window.removeEventListener("deviceorientation", handleOrientation, true);
  }, [isTracking]);

  // Check for unsupported
  useEffect(() => {
    if (!("DeviceOrientationEvent" in window)) {
      setPermissionState("unsupported");
    }
  }, []);

  // Match pointing direction to nearest flight
  useEffect(() => {
    if (!isTracking || compassHeading === null || deviceTilt === null || flights.length === 0) {
      setMatchedFlight(null);
      return;
    }

    // Find flight closest to where we're pointing
    let bestMatch: FlightInfo | null = null;
    let bestScore = Infinity;

    const HEADING_TOLERANCE = 30; // degrees
    const ELEVATION_TOLERANCE = 20; // degrees

    for (const flight of flights) {
      const headingDiff = Math.abs(angleDiff(compassHeading, flight.bearing));
      const elevationDiff = Math.abs(deviceTilt - flight.elevation);

      // Weight heading more than elevation since we're more accurate left/right
      const score = headingDiff * 1.5 + elevationDiff;

      if (headingDiff < HEADING_TOLERANCE && elevationDiff < ELEVATION_TOLERANCE && score < bestScore) {
        bestScore = score;
        bestMatch = flight;
      }
    }

    setMatchedFlight(bestMatch);
  }, [compassHeading, deviceTilt, flights, isTracking]);

  // Show loading state
  if (!location && !locationError) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-4xl mb-4 animate-bounce">✈️</div>
          <p className="text-lg opacity-70">Getting your location...</p>
        </div>
      </main>
    );
  }

  // Show error state
  if (locationError) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="text-4xl mb-4">📍</div>
          <h1 className="text-xl font-bold mb-2">Location Required</h1>
          <p className="opacity-70">{locationError}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 bg-sky-600 hover:bg-sky-700 px-6 py-3 rounded-xl font-medium"
          >
            Try Again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="p-4 border-b border-white/10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">What the Flight?!</h1>
          <div className="text-sm opacity-60">
            {flights.length} planes nearby
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-center p-4">
        {!isTracking ? (
          // Start tracking UI
          <div className="text-center max-w-md">
            <div className="text-6xl mb-6">✈️</div>
            <h2 className="text-2xl font-bold mb-4">Point at a Plane</h2>
            <p className="opacity-70 mb-6">
              Point your phone at any aircraft in the sky and find out where it&apos;s headed!
            </p>

            {permissionState === "unsupported" ? (
              <p className="text-amber-400">
                Device orientation not supported on this device
              </p>
            ) : permissionState === "denied" ? (
              <p className="text-red-400">
                Permission denied. Please enable motion sensors in your browser settings.
              </p>
            ) : (
              <button
                onClick={requestPermission}
                className="bg-sky-600 hover:bg-sky-700 px-8 py-4 rounded-xl font-medium text-lg"
              >
                Start Tracking
              </button>
            )}

            {/* Quick stats */}
            <div className="mt-8 grid grid-cols-2 gap-4 text-sm">
              <div className="bg-white/5 rounded-lg p-3">
                <div className="text-2xl font-bold text-sky-400">{flights.length}</div>
                <div className="opacity-60">Aircraft</div>
              </div>
              <div className="bg-white/5 rounded-lg p-3">
                <div className="text-2xl font-bold text-sky-400">
                  {flights[0] ? formatDistance(flights[0].distance) : "—"}
                </div>
                <div className="opacity-60">Nearest</div>
              </div>
            </div>
          </div>
        ) : (
          // Tracking UI
          <div className="w-full max-w-md">
            {/* Compass visualization */}
            <div className="relative mb-6">
              <div className="aspect-square max-w-[300px] mx-auto">
                <svg viewBox="0 0 200 200" className="w-full h-full">
                  {/* Compass ring */}
                  <circle cx="100" cy="100" r="95" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
                  <circle cx="100" cy="100" r="80" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />

                  {/* Rotating compass with aircraft markers */}
                  <g style={{ transform: `rotate(${-(compassHeading ?? 0)}deg)`, transformOrigin: "100px 100px" }}>
                    {/* Cardinal directions */}
                    <text x="100" y="18" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">N</text>
                    <text x="185" y="104" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="10">E</text>
                    <text x="100" y="192" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="10">S</text>
                    <text x="15" y="104" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="10">W</text>

                    {/* Tick marks */}
                    {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => (
                      <line
                        key={deg}
                        x1="100"
                        y1="8"
                        x2="100"
                        y2={deg % 90 === 0 ? "22" : "15"}
                        stroke={deg === 0 ? "white" : "rgba(255,255,255,0.3)"}
                        strokeWidth={deg % 90 === 0 ? "2" : "1"}
                        style={{ transform: `rotate(${deg}deg)`, transformOrigin: "100px 100px" }}
                      />
                    ))}

                    {/* Aircraft markers */}
                    {flights.slice(0, 20).map((flight) => {
                      const isMatched = matchedFlight?.icao24 === flight.icao24;
                      // Map distance to radius (closer = further from center)
                      const maxDist = 100; // km
                      const normalizedDist = Math.min(flight.distance / maxDist, 1);
                      const r = 30 + normalizedDist * 50; // 30-80 from center
                      const x = 100 + r * Math.sin((flight.bearing * Math.PI) / 180);
                      const y = 100 - r * Math.cos((flight.bearing * Math.PI) / 180);

                      return (
                        <g key={flight.icao24}>
                          <circle
                            cx={x}
                            cy={y}
                            r={isMatched ? 8 : 4}
                            fill={isMatched ? "#22c55e" : "#0ea5e9"}
                            className={isMatched ? "animate-pulse" : ""}
                          />
                          {isMatched && (
                            <text
                              x={x}
                              y={y - 12}
                              textAnchor="middle"
                              fill="white"
                              fontSize="8"
                              fontWeight="bold"
                            >
                              {flight.callsign}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </g>

                  {/* Center pointer (where you're pointing) */}
                  <polygon points="100,30 94,50 106,50" fill="white" />
                  <circle cx="100" cy="100" r="6" fill="white" />
                </svg>
              </div>

              {/* Current heading */}
              <div className="text-center mt-2 opacity-60 text-sm">
                {Math.round(compassHeading ?? 0)}° {bearingToDirection(compassHeading ?? 0)}
                {deviceTilt !== null && ` • ${Math.round(deviceTilt)}° up`}
              </div>
            </div>

            {/* Matched flight info */}
            {matchedFlight ? (
              <div
                className="bg-green-500/20 border-2 border-green-500 rounded-xl p-4 cursor-pointer"
                onClick={() => setSelectedFlight(matchedFlight)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-2xl font-bold">{matchedFlight.callsign}</div>
                  <div className="text-green-400 text-sm font-medium">MATCHED!</div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <div className="opacity-60">Altitude</div>
                    <div className="font-medium">{formatAltitude(matchedFlight.altitude)}</div>
                  </div>
                  <div>
                    <div className="opacity-60">Speed</div>
                    <div className="font-medium">{formatSpeed(matchedFlight.velocity)}</div>
                  </div>
                  <div>
                    <div className="opacity-60">Distance</div>
                    <div className="font-medium">{formatDistance(matchedFlight.distance)}</div>
                  </div>
                </div>
                <div className="mt-2 text-sm opacity-70">
                  From {matchedFlight.origin_country}
                </div>
                <div className="mt-2 text-xs opacity-50">Tap for more info</div>
              </div>
            ) : (
              <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                <div className="text-lg opacity-70 mb-2">Point at a plane</div>
                <div className="text-sm opacity-50">
                  {flights.length > 0
                    ? `${flights.length} aircraft within range`
                    : "No aircraft detected nearby"}
                </div>
              </div>
            )}

            {/* Nearby flights list */}
            <div className="mt-4">
              <div className="text-sm font-medium opacity-60 mb-2">Nearby Flights</div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {flights.slice(0, 10).map((flight) => (
                  <div
                    key={flight.icao24}
                    className={`bg-white/5 rounded-lg p-2 flex items-center justify-between cursor-pointer hover:bg-white/10 ${
                      matchedFlight?.icao24 === flight.icao24 ? "ring-2 ring-green-500" : ""
                    }`}
                    onClick={() => setSelectedFlight(flight)}
                  >
                    <div>
                      <div className="font-medium">{flight.callsign}</div>
                      <div className="text-xs opacity-60">
                        {bearingToDirection(flight.bearing)} • {formatDistance(flight.distance)}
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <div>{formatAltitude(flight.altitude)}</div>
                      <div className="text-xs opacity-60">{Math.round(flight.elevation)}° up</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="p-4 border-t border-white/10 text-center text-sm opacity-50">
        {lastUpdate && `Updated ${Math.round((Date.now() - lastUpdate) / 1000)}s ago`}
        {isLoading && " • Refreshing..."}
      </footer>

      {/* Flight detail modal */}
      {selectedFlight && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50"
          onClick={() => setSelectedFlight(null)}
        >
          <div
            className="bg-[#0c1929] border border-white/20 rounded-2xl p-6 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold">{selectedFlight.callsign}</h2>
              <button
                onClick={() => setSelectedFlight(null)}
                className="opacity-60 hover:opacity-100 text-2xl"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white/5 rounded-lg p-3">
                  <div className="text-sm opacity-60">Altitude</div>
                  <div className="text-xl font-bold">{formatAltitude(selectedFlight.altitude)}</div>
                </div>
                <div className="bg-white/5 rounded-lg p-3">
                  <div className="text-sm opacity-60">Speed</div>
                  <div className="text-xl font-bold">{formatSpeed(selectedFlight.velocity)}</div>
                </div>
                <div className="bg-white/5 rounded-lg p-3">
                  <div className="text-sm opacity-60">Distance</div>
                  <div className="text-xl font-bold">{formatDistance(selectedFlight.distance)}</div>
                </div>
                <div className="bg-white/5 rounded-lg p-3">
                  <div className="text-sm opacity-60">Direction</div>
                  <div className="text-xl font-bold">
                    {bearingToDirection(selectedFlight.bearing)} ({Math.round(selectedFlight.bearing)}°)
                  </div>
                </div>
              </div>

              <div className="bg-white/5 rounded-lg p-3">
                <div className="text-sm opacity-60">Country of Origin</div>
                <div className="text-lg font-medium">{selectedFlight.origin_country}</div>
              </div>

              {selectedFlight.heading !== null && (
                <div className="bg-white/5 rounded-lg p-3">
                  <div className="text-sm opacity-60">Heading</div>
                  <div className="text-lg font-medium">
                    {bearingToDirection(selectedFlight.heading)} ({Math.round(selectedFlight.heading)}°)
                  </div>
                </div>
              )}

              {selectedFlight.vertical_rate !== null && selectedFlight.vertical_rate !== 0 && (
                <div className="bg-white/5 rounded-lg p-3">
                  <div className="text-sm opacity-60">Vertical Rate</div>
                  <div className="text-lg font-medium">
                    {selectedFlight.vertical_rate > 0 ? "↑" : "↓"} {Math.abs(Math.round(selectedFlight.vertical_rate * 196.85))} ft/min
                  </div>
                </div>
              )}

              <div className="text-xs opacity-50 text-center">
                ICAO: {selectedFlight.icao24.toUpperCase()}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
