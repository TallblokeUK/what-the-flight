import { NextRequest, NextResponse } from "next/server";

// Use edge runtime for better performance
export const runtime = "edge";

export const maxDuration = 30;

// Calculate bearing between two points
function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const dLon = toRad(lon2 - lon1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  let bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

// Calculate distance between two points (Haversine formula)
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Calculate elevation angle to aircraft
function calculateElevation(distance: number, altitude: number): number {
  const distanceM = distance * 1000;
  const elevationRad = Math.atan2(altitude, distanceM);
  return (elevationRad * 180) / Math.PI;
}

export interface FlightInfo {
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
  registration?: string;
  aircraft_type?: string;
  operator?: string;
  origin?: string;
  originName?: string;
  destination?: string;
  destinationName?: string;
  squawk?: string;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const lat = parseFloat(searchParams.get("lat") || "");
  const lon = parseFloat(searchParams.get("lon") || "");
  const radiusKm = parseFloat(searchParams.get("radius") || "50"); // 50km default - what you can realistically see

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  // Try AirLabs first (has origin/destination built in!)
  const airLabsKey = process.env.AIRLABS_KEY;
  if (airLabsKey) {
    try {
      const result = await fetchFromAirLabs(lat, lon, radiusKm, airLabsKey);
      if (result) return result;
    } catch (error) {
      console.error("AirLabs error:", error);
    }
  }

  // Fallback to OpenSky
  return fetchFromOpenSky(lat, lon, radiusKm);
}

// Primary source: AirLabs - includes origin/destination!
async function fetchFromAirLabs(lat: number, lon: number, radiusKm: number, apiKey: string) {
  // Calculate bounding box
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  const bbox = `${lat - latDelta},${lon - lonDelta},${lat + latDelta},${lon + lonDelta}`;

  const response = await fetch(
    `https://airlabs.co/api/v9/flights?api_key=${apiKey}&bbox=${bbox}`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    throw new Error(`AirLabs error: ${response.status}`);
  }

  const data = await response.json();

  if (!data.response || data.response.length === 0) {
    return NextResponse.json({
      flights: [],
      timestamp: Date.now(),
      source: "airlabs",
    });
  }

  const flights: FlightInfo[] = data.response
    .map((flight: Record<string, unknown>): FlightInfo | null => {
      const acLat = flight.lat as number | undefined;
      const acLon = flight.lng as number | undefined;
      const altitude = ((flight.alt as number) || 0) * 0.3048; // AirLabs returns feet, convert to meters

      if (!acLat || !acLon) return null;
      if (altitude < 100) return null; // Filter ground/very low aircraft

      const bearing = calculateBearing(lat, lon, acLat, acLon);
      const distance = calculateDistance(lat, lon, acLat, acLon);
      const elevation = calculateElevation(distance, altitude);

      // Skip if outside our radius (bbox is a square, we want a circle)
      if (distance > radiusKm) return null;

      return {
        icao24: (flight.hex as string) || (flight.icao_24 as string) || "unknown",
        callsign: ((flight.flight_icao as string) || (flight.flight_iata as string) || "").trim() || "Unknown",
        origin_country: (flight.flag as string) || "",
        latitude: acLat,
        longitude: acLon,
        altitude,
        velocity: flight.speed ? (flight.speed as number) * 0.514444 : null, // knots to m/s
        heading: (flight.dir as number) ?? null,
        vertical_rate: flight.v_speed ? (flight.v_speed as number) * 0.00508 : null, // ft/min to m/s
        on_ground: false,
        bearing,
        distance,
        elevation,
        registration: flight.reg_number as string | undefined,
        aircraft_type: flight.aircraft_icao as string | undefined,
        operator: flight.airline_name as string | undefined,
        origin: (flight.dep_iata as string) || (flight.dep_icao as string),
        originName: flight.dep_city as string | undefined,
        destination: (flight.arr_iata as string) || (flight.arr_icao as string),
        destinationName: flight.arr_city as string | undefined,
        squawk: flight.squawk as string | undefined,
      };
    })
    .filter((f: FlightInfo | null): f is FlightInfo => f !== null)
    .sort((a: FlightInfo, b: FlightInfo) => a.distance - b.distance);

  return NextResponse.json({
    flights,
    timestamp: Date.now(),
    userLocation: { lat, lon },
    source: "airlabs",
    debug: {
      rawCount: data.response?.length || 0,
      filteredCount: flights.length,
      radiusKm,
    },
  });
}

// Fallback to OpenSky Network
async function fetchFromOpenSky(lat: number, lon: number, radiusKm: number) {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  const lamin = lat - latDelta;
  const lamax = lat + latDelta;
  const lomin = lon - lonDelta;
  const lomax = lon + lonDelta;

  try {
    const apiUrl = `https://opensky-network.org/api/states/all?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(apiUrl, {
      headers: { "User-Agent": "WhatTheFlight/1.0" },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return NextResponse.json({
        flights: [],
        error: `OpenSky API error: ${response.status}`,
        timestamp: Date.now(),
        source: "opensky",
      });
    }

    const data = await response.json();

    if (!data.states || data.states.length === 0) {
      return NextResponse.json({
        flights: [],
        timestamp: data.time ? data.time * 1000 : Date.now(),
        source: "opensky",
      });
    }

    const flights: FlightInfo[] = data.states
      .map((state: (string | number | boolean | null)[]): FlightInfo | null => {
        const [
          icao24, callsign, origin_country, , , longitude, latitude,
          baro_altitude, on_ground, velocity, true_track, vertical_rate,
          , geo_altitude,
        ] = state;

        if (latitude === null || longitude === null) return null;

        const altitude = (geo_altitude as number) ?? (baro_altitude as number) ?? 0;
        if (on_ground || altitude < 100) return null;

        const bearing = calculateBearing(lat, lon, latitude as number, longitude as number);
        const distance = calculateDistance(lat, lon, latitude as number, longitude as number);
        const elevation = calculateElevation(distance, altitude);

        return {
          icao24: icao24 as string,
          callsign: ((callsign as string) || "").trim() || "Unknown",
          origin_country: origin_country as string,
          latitude: latitude as number,
          longitude: longitude as number,
          altitude,
          velocity: velocity as number | null,
          heading: true_track as number | null,
          vertical_rate: vertical_rate as number | null,
          on_ground: on_ground as boolean,
          bearing,
          distance,
          elevation,
        };
      })
      .filter((f: FlightInfo | null): f is FlightInfo => f !== null)
      .sort((a: FlightInfo, b: FlightInfo) => a.distance - b.distance);

    return NextResponse.json({
      flights,
      timestamp: data.time ? data.time * 1000 : Date.now(),
      userLocation: { lat, lon },
      source: "opensky",
      debug: {
        rawCount: data.states?.length || 0,
        filteredCount: flights.length,
      },
    });
  } catch (error) {
    return NextResponse.json({
      flights: [],
      error: `Failed to fetch: ${error instanceof Error ? error.message : "Unknown error"}`,
      timestamp: Date.now(),
      source: "opensky",
    });
  }
}
