import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// Simple in-memory cache (will reset on cold starts, but helps during session)
const routeCache = new Map<string, { origin: string; destination: string; airline: string; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

export interface RouteInfo {
  origin?: string;
  originName?: string;
  destination?: string;
  destinationName?: string;
  airline?: string;
  flightNumber?: string;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const callsign = searchParams.get("callsign")?.trim().toUpperCase();

  if (!callsign) {
    return NextResponse.json({ error: "Callsign required" }, { status: 400 });
  }

  // Check cache first
  const cached = routeCache.get(callsign);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json({
      origin: cached.origin,
      destination: cached.destination,
      airline: cached.airline,
      cached: true,
    });
  }

  // Try to decode airline from callsign (first 3 chars are usually ICAO airline code)
  const airlineIcao = callsign.slice(0, 3);
  const flightNumber = callsign.slice(3);

  // Use AeroDataBox via RapidAPI to look up the flight
  const rapidApiKey = process.env.RAPIDAPI_KEY;

  if (!rapidApiKey) {
    return NextResponse.json({
      error: "Route lookup not configured",
      airline: getAirlineName(airlineIcao),
      flightNumber,
    });
  }

  try {
    // Try to find the flight using AeroDataBox
    const response = await fetch(
      `https://aerodatabox.p.rapidapi.com/flights/callsign/${callsign}`,
      {
        headers: {
          "X-RapidAPI-Key": rapidApiKey,
          "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
        },
      }
    );

    if (!response.ok) {
      // Fallback to just airline name
      return NextResponse.json({
        airline: getAirlineName(airlineIcao),
        flightNumber,
        error: `Lookup failed: ${response.status}`,
      });
    }

    const data = await response.json();

    // AeroDataBox returns an array of matching flights
    if (data && Array.isArray(data) && data.length > 0) {
      const flight = data[0];
      const result = {
        origin: flight.departure?.airport?.iata || flight.departure?.airport?.icao,
        originName: flight.departure?.airport?.name,
        destination: flight.arrival?.airport?.iata || flight.arrival?.airport?.icao,
        destinationName: flight.arrival?.airport?.name,
        airline: flight.airline?.name || getAirlineName(airlineIcao),
        flightNumber: flight.number || flightNumber,
      };

      // Cache the result
      if (result.origin && result.destination) {
        routeCache.set(callsign, {
          origin: result.origin,
          destination: result.destination,
          airline: result.airline || "",
          timestamp: Date.now(),
        });
      }

      return NextResponse.json(result);
    }

    // No results found
    return NextResponse.json({
      airline: getAirlineName(airlineIcao),
      flightNumber,
      notFound: true,
    });
  } catch (error) {
    console.error("Route lookup error:", error);
    return NextResponse.json({
      airline: getAirlineName(airlineIcao),
      flightNumber,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// Common airline ICAO codes to names
function getAirlineName(icao: string): string | undefined {
  const airlines: Record<string, string> = {
    // UK & Ireland
    BAW: "British Airways",
    EZY: "easyJet",
    RYR: "Ryanair",
    TOM: "TUI Airways",
    VIR: "Virgin Atlantic",
    EIN: "Aer Lingus",
    LOG: "Loganair",
    BEE: "Flybe",
    SHT: "BA Shuttle",
    CFE: "BA CityFlyer",
    // European
    AFR: "Air France",
    DLH: "Lufthansa",
    KLM: "KLM",
    IBE: "Iberia",
    TAP: "TAP Portugal",
    SAS: "Scandinavian",
    FIN: "Finnair",
    AZA: "ITA Airways",
    SWR: "Swiss",
    AUA: "Austrian",
    BEL: "Brussels Airlines",
    VLG: "Vueling",
    EWG: "Eurowings",
    WZZ: "Wizz Air",
    NOZ: "Norwegian",
    // North American
    AAL: "American Airlines",
    UAL: "United Airlines",
    DAL: "Delta Air Lines",
    SWA: "Southwest",
    JBU: "JetBlue",
    ACA: "Air Canada",
    WJA: "WestJet",
    // Middle East
    UAE: "Emirates",
    ETD: "Etihad",
    QTR: "Qatar Airways",
    THY: "Turkish Airlines",
    GFA: "Gulf Air",
    SVA: "Saudia",
    MEA: "Middle East Airlines",
    // Asia Pacific
    SIA: "Singapore Airlines",
    CPA: "Cathay Pacific",
    JAL: "Japan Airlines",
    ANA: "All Nippon Airways",
    KAL: "Korean Air",
    CES: "China Eastern",
    CSN: "China Southern",
    CCA: "Air China",
    QFA: "Qantas",
    ANZ: "Air New Zealand",
    MAS: "Malaysia Airlines",
    THA: "Thai Airways",
    EVA: "EVA Air",
    // Cargo
    FDX: "FedEx",
    UPS: "UPS",
    GTI: "Atlas Air",
  };

  return airlines[icao];
}
