import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// Simple in-memory cache (will reset on cold starts, but helps during session)
const routeCache = new Map<string, { origin: string; destination: string; airline: string; originName?: string; destinationName?: string; timestamp: number }>();
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
      originName: cached.originName,
      destination: cached.destination,
      destinationName: cached.destinationName,
      airline: cached.airline,
      cached: true,
    });
  }

  // Try to decode airline from callsign (first 3 chars are usually ICAO airline code)
  const airlineIcao = callsign.slice(0, 3);
  const flightNumber = callsign.slice(3);

  // Try AirLabs first (1000 requests/month free)
  const airLabsKey = process.env.AIRLABS_KEY;
  if (airLabsKey) {
    try {
      const result = await fetchFromAirLabs(callsign, airLabsKey, airlineIcao, flightNumber);
      if (result.origin || result.destination) {
        // Cache successful result
        routeCache.set(callsign, {
          origin: result.origin || "",
          destination: result.destination || "",
          originName: result.originName,
          destinationName: result.destinationName,
          airline: result.airline || "",
          timestamp: Date.now(),
        });
        return NextResponse.json(result);
      }
    } catch (error) {
      console.error("AirLabs error:", error);
    }
  }

  // Try AviationStack as backup (100 requests/month free)
  const aviationStackKey = process.env.AVIATIONSTACK_KEY;
  if (aviationStackKey) {
    try {
      const result = await fetchFromAviationStack(callsign, aviationStackKey, airlineIcao, flightNumber);
      if (result.origin || result.destination) {
        // Cache successful result
        routeCache.set(callsign, {
          origin: result.origin || "",
          destination: result.destination || "",
          originName: result.originName,
          destinationName: result.destinationName,
          airline: result.airline || "",
          timestamp: Date.now(),
        });
        return NextResponse.json(result);
      }
    } catch (error) {
      console.error("AviationStack error:", error);
    }
  }

  // Fallback to just airline name from ICAO code
  return NextResponse.json({
    airline: getAirlineName(airlineIcao),
    flightNumber,
  });
}

async function fetchFromAirLabs(
  callsign: string,
  apiKey: string,
  airlineIcao: string,
  flightNumber: string
): Promise<RouteInfo> {
  // AirLabs uses flight_icao parameter
  const response = await fetch(
    `https://airlabs.co/api/v9/flights?api_key=${apiKey}&flight_icao=${callsign}`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    throw new Error(`AirLabs error: ${response.status}`);
  }

  const data = await response.json();

  if (data.response && data.response.length > 0) {
    const flight = data.response[0];
    return {
      origin: flight.dep_iata || flight.dep_icao,
      originName: flight.dep_city,
      destination: flight.arr_iata || flight.arr_icao,
      destinationName: flight.arr_city,
      airline: flight.airline_name || getAirlineName(airlineIcao),
      flightNumber: flight.flight_number || flightNumber,
    };
  }

  return {
    airline: getAirlineName(airlineIcao),
    flightNumber,
  };
}

async function fetchFromAviationStack(
  callsign: string,
  apiKey: string,
  airlineIcao: string,
  flightNumber: string
): Promise<RouteInfo> {
  // AviationStack uses flight_icao parameter
  const response = await fetch(
    `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_icao=${callsign}`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    throw new Error(`AviationStack error: ${response.status}`);
  }

  const data = await response.json();

  if (data.data && data.data.length > 0) {
    const flight = data.data[0];
    return {
      origin: flight.departure?.iata || flight.departure?.icao,
      originName: flight.departure?.airport,
      destination: flight.arrival?.iata || flight.arrival?.icao,
      destinationName: flight.arrival?.airport,
      airline: flight.airline?.name || getAirlineName(airlineIcao),
      flightNumber: flight.flight?.number || flightNumber,
    };
  }

  return {
    airline: getAirlineName(airlineIcao),
    flightNumber,
  };
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
