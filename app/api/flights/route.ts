import { NextRequest, NextResponse } from "next/server";

// OpenSky Network API response type
interface OpenSkyState {
  icao24: string;
  callsign: string | null;
  origin_country: string;
  time_position: number | null;
  last_contact: number;
  longitude: number | null;
  latitude: number | null;
  baro_altitude: number | null;
  on_ground: boolean;
  velocity: number | null;
  true_track: number | null;
  vertical_rate: number | null;
  sensors: number[] | null;
  geo_altitude: number | null;
  squawk: string | null;
  spi: boolean;
  position_source: number;
}

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
  // distance in km, altitude in meters
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
  altitude: number; // meters
  velocity: number | null; // m/s
  heading: number | null;
  vertical_rate: number | null;
  on_ground: boolean;
  // Calculated fields
  bearing: number; // degrees from user
  distance: number; // km from user
  elevation: number; // degrees above horizon
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const lat = parseFloat(searchParams.get("lat") || "");
  const lon = parseFloat(searchParams.get("lon") || "");
  const radius = parseFloat(searchParams.get("radius") || "200"); // Default 200km

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  // Calculate bounding box for OpenSky API
  // 1 degree latitude ≈ 111km
  // 1 degree longitude ≈ 111km * cos(latitude)
  const latDelta = radius / 111;
  const lonDelta = radius / (111 * Math.cos((lat * Math.PI) / 180));

  const lamin = lat - latDelta;
  const lamax = lat + latDelta;
  const lomin = lon - lonDelta;
  const lomax = lon + lonDelta;

  try {
    // OpenSky Network API - free, no auth needed for basic use
    const apiUrl = `https://opensky-network.org/api/states/all?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;

    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "WhatTheFlight/1.0",
      },
      cache: "no-store", // Don't cache - we want fresh data
    });

    if (!response.ok) {
      // OpenSky has rate limits - return empty if rate limited
      if (response.status === 429) {
        return NextResponse.json({
          flights: [],
          error: "Rate limited - please wait a moment",
          timestamp: Date.now(),
        });
      }
      return NextResponse.json({
        flights: [],
        error: `OpenSky API error: ${response.status} ${response.statusText}`,
        timestamp: Date.now(),
        debug: { apiUrl, status: response.status },
      });
    }

    const data = await response.json();

    if (!data.states || data.states.length === 0) {
      return NextResponse.json({
        flights: [],
        timestamp: data.time * 1000,
      });
    }

    // Transform and enrich flight data
    const flights: FlightInfo[] = data.states
      .map((state: (string | number | boolean | null)[]): FlightInfo | null => {
        const [
          icao24,
          callsign,
          origin_country,
          , // time_position
          , // last_contact
          longitude,
          latitude,
          baro_altitude,
          on_ground,
          velocity,
          true_track,
          vertical_rate,
          , // sensors
          geo_altitude,
        ] = state;

        // Skip if no position
        if (latitude === null || longitude === null) return null;

        // Use geometric altitude if available, otherwise barometric
        const altitude = (geo_altitude as number) ?? (baro_altitude as number) ?? 0;

        // Skip aircraft on ground or with no altitude
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
      timestamp: data.time * 1000,
      userLocation: { lat, lon },
      debug: {
        rawCount: data.states?.length || 0,
        filteredCount: flights.length,
        boundingBox: { lamin, lamax, lomin, lomax },
        radius,
      },
    });
  } catch (error) {
    console.error("Flight API error:", error);
    return NextResponse.json({
      error: `Failed to fetch flight data: ${error instanceof Error ? error.message : "Unknown error"}`,
      flights: [],
      timestamp: Date.now(),
    });
  }
}
