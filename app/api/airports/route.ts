import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// Common airports - covers most flights you'll see
const AIRPORTS: Record<string, { name: string; city: string }> = {
  // UK
  LHR: { name: "Heathrow", city: "London" },
  LGW: { name: "Gatwick", city: "London" },
  STN: { name: "Stansted", city: "London" },
  LTN: { name: "Luton", city: "London" },
  LCY: { name: "City", city: "London" },
  MAN: { name: "Manchester", city: "Manchester" },
  BHX: { name: "Birmingham", city: "Birmingham" },
  EDI: { name: "Edinburgh", city: "Edinburgh" },
  GLA: { name: "Glasgow", city: "Glasgow" },
  BRS: { name: "Bristol", city: "Bristol" },
  NCL: { name: "Newcastle", city: "Newcastle" },
  LPL: { name: "Liverpool", city: "Liverpool" },
  LBA: { name: "Leeds Bradford", city: "Leeds" },
  EMA: { name: "East Midlands", city: "Nottingham" },
  SOU: { name: "Southampton", city: "Southampton" },
  ABZ: { name: "Aberdeen", city: "Aberdeen" },
  BFS: { name: "Belfast Intl", city: "Belfast" },
  BHD: { name: "Belfast City", city: "Belfast" },
  CWL: { name: "Cardiff", city: "Cardiff" },
  // Ireland
  DUB: { name: "Dublin", city: "Dublin" },
  SNN: { name: "Shannon", city: "Shannon" },
  ORK: { name: "Cork", city: "Cork" },
  // Europe Major
  CDG: { name: "Charles de Gaulle", city: "Paris" },
  ORY: { name: "Orly", city: "Paris" },
  AMS: { name: "Schiphol", city: "Amsterdam" },
  FRA: { name: "Frankfurt", city: "Frankfurt" },
  MUC: { name: "Munich", city: "Munich" },
  FCO: { name: "Fiumicino", city: "Rome" },
  MAD: { name: "Barajas", city: "Madrid" },
  BCN: { name: "El Prat", city: "Barcelona" },
  LIS: { name: "Lisbon", city: "Lisbon" },
  ZRH: { name: "Zurich", city: "Zurich" },
  VIE: { name: "Vienna", city: "Vienna" },
  BRU: { name: "Brussels", city: "Brussels" },
  CPH: { name: "Copenhagen", city: "Copenhagen" },
  OSL: { name: "Oslo", city: "Oslo" },
  ARN: { name: "Arlanda", city: "Stockholm" },
  HEL: { name: "Helsinki", city: "Helsinki" },
  ATH: { name: "Athens", city: "Athens" },
  IST: { name: "Istanbul", city: "Istanbul" },
  // Holiday destinations
  PMI: { name: "Palma", city: "Mallorca" },
  AGP: { name: "Malaga", city: "Malaga" },
  ALC: { name: "Alicante", city: "Alicante" },
  TFS: { name: "Tenerife South", city: "Tenerife" },
  LPA: { name: "Gran Canaria", city: "Gran Canaria" },
  FAO: { name: "Faro", city: "Faro" },
  NCE: { name: "Nice", city: "Nice" },
  // North America
  JFK: { name: "JFK", city: "New York" },
  EWR: { name: "Newark", city: "New York" },
  LGA: { name: "LaGuardia", city: "New York" },
  LAX: { name: "LAX", city: "Los Angeles" },
  ORD: { name: "O'Hare", city: "Chicago" },
  DFW: { name: "DFW", city: "Dallas" },
  ATL: { name: "Hartsfield", city: "Atlanta" },
  MIA: { name: "Miami", city: "Miami" },
  SFO: { name: "SFO", city: "San Francisco" },
  BOS: { name: "Logan", city: "Boston" },
  IAD: { name: "Dulles", city: "Washington" },
  SEA: { name: "Seattle", city: "Seattle" },
  YYZ: { name: "Pearson", city: "Toronto" },
  YVR: { name: "Vancouver", city: "Vancouver" },
  YUL: { name: "Montreal", city: "Montreal" },
  // Middle East
  DXB: { name: "Dubai", city: "Dubai" },
  AUH: { name: "Abu Dhabi", city: "Abu Dhabi" },
  DOH: { name: "Hamad", city: "Doha" },
  // Asia
  HKG: { name: "Hong Kong", city: "Hong Kong" },
  SIN: { name: "Changi", city: "Singapore" },
  NRT: { name: "Narita", city: "Tokyo" },
  HND: { name: "Haneda", city: "Tokyo" },
  ICN: { name: "Incheon", city: "Seoul" },
  BKK: { name: "Suvarnabhumi", city: "Bangkok" },
  PEK: { name: "Beijing", city: "Beijing" },
  PVG: { name: "Pudong", city: "Shanghai" },
  DEL: { name: "Indira Gandhi", city: "Delhi" },
  BOM: { name: "Mumbai", city: "Mumbai" },
  // Oceania
  SYD: { name: "Sydney", city: "Sydney" },
  MEL: { name: "Melbourne", city: "Melbourne" },
  AKL: { name: "Auckland", city: "Auckland" },
};

// Simple in-memory cache for API lookups
const airportCache = new Map<string, { name: string; city: string; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code")?.trim().toUpperCase();

  if (!code) {
    return NextResponse.json({ error: "Airport code required" }, { status: 400 });
  }

  // Check built-in dictionary first
  if (AIRPORTS[code]) {
    return NextResponse.json(AIRPORTS[code]);
  }

  // Check cache
  const cached = airportCache.get(code);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json({ name: cached.name, city: cached.city });
  }

  // Try AirLabs API
  const apiKey = process.env.AIRLABS_KEY;
  if (apiKey) {
    try {
      const response = await fetch(
        `https://airlabs.co/api/v9/airports?api_key=${apiKey}&iata_code=${code}`,
        { cache: "no-store" }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.response && data.response.length > 0) {
          const airport = data.response[0];
          const result = {
            name: airport.name || code,
            city: airport.city || airport.country_code || "",
          };
          // Cache the result
          airportCache.set(code, { ...result, timestamp: Date.now() });
          return NextResponse.json(result);
        }
      }
    } catch (error) {
      console.error("Airport lookup error:", error);
    }
  }

  // Return just the code if we can't find it
  return NextResponse.json({ name: code, city: "" });
}
