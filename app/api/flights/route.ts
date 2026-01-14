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
  // Extra fields from ADSB Exchange
  registration?: string;
  aircraft_type?: string;
  operator?: string;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const lat = parseFloat(searchParams.get("lat") || "");
  const lon = parseFloat(searchParams.get("lon") || "");
  const radiusKm = parseFloat(searchParams.get("radius") || "200");

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  // Convert km to nautical miles (1 nm = 1.852 km)
  // Max 250 nm for ADSB Exchange API
  const radiusNm = Math.min(Math.round(radiusKm / 1.852), 250);

  const apiKey = process.env.RAPIDAPI_KEY;

  if (!apiKey) {
    // Fallback: Try OpenSky as backup
    return fetchFromOpenSky(lat, lon, radiusKm);
  }

  try {
    const apiUrl = `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${lat}/lon/${lon}/dist/${radiusNm}/`;

    const response = await fetch(apiUrl, {
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": "adsbexchange-com1.p.rapidapi.com",
      },
    });

    if (!response.ok) {
      console.error("ADSB Exchange error:", response.status);
      // Fallback to OpenSky
      return fetchFromOpenSky(lat, lon, radiusKm);
    }

    const data = await response.json();

    if (!data.ac || data.ac.length === 0) {
      return NextResponse.json({
        flights: [],
        timestamp: Date.now(),
        source: "adsbexchange",
      });
    }

    const flights: FlightInfo[] = data.ac
      .map((ac: Record<string, unknown>): FlightInfo | null => {
        const acLat = ac.lat as number | undefined;
        const acLon = ac.lon as number | undefined;
        const altitude = (ac.alt_geom as number) ?? (ac.alt_baro as number) ?? 0;

        if (!acLat || !acLon) return null;
        if (ac.on_ground || altitude < 100) return null;

        const bearing = calculateBearing(lat, lon, acLat, acLon);
        const distance = calculateDistance(lat, lon, acLat, acLon);
        const elevation = calculateElevation(distance, altitude * 0.3048); // Convert feet to meters

        return {
          icao24: (ac.hex as string) || "unknown",
          callsign: ((ac.flight as string) || "").trim() || (ac.r as string) || "Unknown",
          origin_country: (ac.dbFlags as number) === 1 ? "Military" : "",
          latitude: acLat,
          longitude: acLon,
          altitude: altitude * 0.3048, // Convert to meters
          velocity: ac.gs ? (ac.gs as number) * 0.514444 : null, // knots to m/s
          heading: (ac.track as number) ?? null,
          vertical_rate: ac.baro_rate ? (ac.baro_rate as number) * 0.00508 : null, // ft/min to m/s
          on_ground: !!ac.on_ground,
          bearing,
          distance,
          elevation,
          registration: ac.r as string | undefined,
          aircraft_type: ac.t as string | undefined,
          operator: ac.ownOp as string | undefined,
        };
      })
      .filter((f: FlightInfo | null): f is FlightInfo => f !== null)
      .sort((a: FlightInfo, b: FlightInfo) => a.distance - b.distance);

    return NextResponse.json({
      flights,
      timestamp: Date.now(),
      userLocation: { lat, lon },
      source: "adsbexchange",
      debug: {
        rawCount: data.ac?.length || 0,
        filteredCount: flights.length,
        radiusNm,
      },
    });
  } catch (error) {
    console.error("ADSB Exchange error:", error);
    // Fallback to OpenSky
    return fetchFromOpenSky(lat, lon, radiusKm);
  }
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
