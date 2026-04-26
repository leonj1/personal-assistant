import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const SERPAPI_BASE = "https://serpapi.com/search.json";

async function serpApiRequest(
  params: Record<string, string | number | undefined>,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("SERPAPI_API_KEY is not configured.");
  }
  const url = new URL(SERPAPI_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("api_key", apiKey);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`SerpAPI HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  const error = json.error;
  if (typeof error === "string" && error.length > 0) {
    throw new Error(`SerpAPI: ${error}`);
  }
  return json;
}

// ----- flight_search -----

const flightSearchParams = Type.Object({
  departure_id: Type.String({
    description:
      "Origin: 3-letter IATA airport code (e.g., 'AUS', 'JFK') or comma-separated codes for multi-airport cities."
  }),
  arrival_id: Type.String({
    description: "Destination: 3-letter IATA airport code (e.g., 'LHR', 'NRT')."
  }),
  outbound_date: Type.String({
    description: "Outbound date in YYYY-MM-DD format."
  }),
  return_date: Type.Optional(
    Type.String({
      description: "Return date in YYYY-MM-DD format. Required when type='round_trip'."
    })
  ),
  type: Type.Optional(
    Type.Union(
      [Type.Literal("round_trip"), Type.Literal("one_way")],
      { default: "round_trip", description: "Trip type. Default: round_trip." }
    )
  ),
  adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 9, default: 1 })),
  currency: Type.Optional(Type.String({ default: "USD", description: "ISO currency code." })),
  travel_class: Type.Optional(
    Type.Union(
      [
        Type.Literal("economy"),
        Type.Literal("premium_economy"),
        Type.Literal("business"),
        Type.Literal("first")
      ],
      { default: "economy" }
    )
  )
});

type FlightLeg = {
  departure_airport?: { id?: string; name?: string; time?: string };
  arrival_airport?: { id?: string; name?: string; time?: string };
  duration?: number;
  airline?: string;
  flight_number?: string;
  travel_class?: string;
};

type FlightOption = {
  flights?: FlightLeg[];
  total_duration?: number;
  price?: number;
  type?: string;
  airline_logo?: string;
  layovers?: Array<{ duration?: number; name?: string }>;
};

type FlightSearchResult = {
  best_flights?: FlightOption[];
  other_flights?: FlightOption[];
  price_insights?: {
    lowest_price?: number;
    price_level?: string;
    typical_price_range?: [number, number];
  };
  search_metadata?: { google_flights_url?: string };
};

const TYPE_TO_NUMERIC: Record<string, string> = {
  round_trip: "1",
  one_way: "2"
};

const TRAVEL_CLASS_TO_NUMERIC: Record<string, string> = {
  economy: "1",
  premium_economy: "2",
  business: "3",
  first: "4"
};

function formatDuration(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return "?";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatFlightOption(option: FlightOption, index: number, currency: string): string {
  const legs = option.flights ?? [];
  const first = legs[0];
  const last = legs[legs.length - 1];
  const dep = first?.departure_airport;
  const arr = last?.arrival_airport;
  const stops = legs.length > 1 ? `${legs.length - 1} stop${legs.length - 1 === 1 ? "" : "s"}` : "nonstop";
  const layoverInfo = (option.layovers ?? [])
    .map((l) => `${l.name ?? "?"} ${formatDuration(l.duration)}`)
    .join(", ");
  const airlines = Array.from(new Set(legs.map((l) => l.airline).filter(Boolean))).join(", ");
  const price = option.price !== undefined ? `${currency} ${option.price}` : "?";
  return (
    `${index + 1}. ${price} - ${airlines || "?"} (${stops}, ${formatDuration(option.total_duration)})\n` +
    `   ${dep?.id ?? "?"} ${dep?.time ?? "?"} -> ${arr?.id ?? "?"} ${arr?.time ?? "?"}` +
    (layoverInfo ? `\n   layovers: ${layoverInfo}` : "")
  );
}

const flightSearchTool = defineTool({
  name: "flight_search",
  label: "Search Google Flights",
  description:
    "Search Google Flights via SerpAPI. Returns best flight options with price, duration, stops, and airlines. Prices are snapshots and not bookable - confirm on the airline/booking site before relying on them.",
  promptSnippet:
    "flight_search: query Google Flights for fares between two airports on given dates. Snapshot prices only.",
  parameters: flightSearchParams,
  async execute(_id, params: Static<typeof flightSearchParams>, signal) {
    const tripType = params.type ?? "round_trip";
    if (tripType === "round_trip" && !params.return_date) {
      throw new Error("return_date is required when type='round_trip'.");
    }
    const currency = params.currency ?? "USD";
    const data = (await serpApiRequest(
      {
        engine: "google_flights",
        departure_id: params.departure_id.toUpperCase(),
        arrival_id: params.arrival_id.toUpperCase(),
        outbound_date: params.outbound_date,
        return_date: tripType === "round_trip" ? params.return_date : undefined,
        type: TYPE_TO_NUMERIC[tripType],
        adults: params.adults ?? 1,
        currency,
        travel_class: TRAVEL_CLASS_TO_NUMERIC[params.travel_class ?? "economy"],
        hl: "en",
        gl: "us"
      },
      signal
    )) as FlightSearchResult;

    const best = (data.best_flights ?? []).slice(0, 5);
    const others = (data.other_flights ?? []).slice(0, 3);

    const insightLines: string[] = [];
    if (data.price_insights?.lowest_price !== undefined) {
      insightLines.push(`Lowest: ${currency} ${data.price_insights.lowest_price}`);
    }
    if (data.price_insights?.price_level) {
      insightLines.push(`Level: ${data.price_insights.price_level}`);
    }
    if (data.price_insights?.typical_price_range) {
      const [lo, hi] = data.price_insights.typical_price_range;
      insightLines.push(`Typical: ${currency} ${lo}-${hi}`);
    }
    const url = data.search_metadata?.google_flights_url;
    const searchedAt = new Date().toISOString();

    const blocks: string[] = [];
    if (insightLines.length) blocks.push(insightLines.join("  "));
    if (best.length) {
      blocks.push("Best flights:\n" + best.map((o, i) => formatFlightOption(o, i, currency)).join("\n\n"));
    }
    if (others.length) {
      blocks.push("Other flights:\n" + others.map((o, i) => formatFlightOption(o, i, currency)).join("\n\n"));
    }
    if (!best.length && !others.length) {
      blocks.push("No flights found.");
    }
    if (url) blocks.push(`Open on Google Flights: ${url}`);
    blocks.push(`(searched_at: ${searchedAt} - prices are snapshots, not bookable)`);

    return {
      content: [{ type: "text", text: blocks.join("\n\n") }],
      details: {
        best: best.length,
        others: others.length,
        lowest_price: data.price_insights?.lowest_price
      }
    };
  }
});

// ----- hotel_search -----

const hotelSearchParams = Type.Object({
  q: Type.String({
    description: "Hotel search query (city, neighborhood, or specific location, e.g., 'Tokyo Shinjuku hotels')."
  }),
  check_in_date: Type.String({
    description: "Check-in date in YYYY-MM-DD format."
  }),
  check_out_date: Type.String({
    description: "Check-out date in YYYY-MM-DD format."
  }),
  adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 2 })),
  children: Type.Optional(Type.Integer({ minimum: 0, maximum: 8, default: 0 })),
  currency: Type.Optional(Type.String({ default: "USD", description: "ISO currency code." })),
  min_price: Type.Optional(Type.Integer({ minimum: 0 })),
  max_price: Type.Optional(Type.Integer({ minimum: 0 })),
  rating: Type.Optional(
    Type.Union(
      [Type.Literal("3.5"), Type.Literal("4.0"), Type.Literal("4.5")],
      { description: "Minimum hotel rating." }
    )
  )
});

type HotelProperty = {
  name?: string;
  type?: string;
  description?: string;
  link?: string;
  gps_coordinates?: { latitude?: number; longitude?: number };
  hotel_class?: string;
  overall_rating?: number;
  reviews?: number;
  rate_per_night?: { lowest?: string; extracted_lowest?: number };
  total_rate?: { lowest?: string; extracted_lowest?: number };
  amenities?: string[];
  nearby_places?: Array<{ name?: string }>;
};

type HotelSearchResult = {
  properties?: HotelProperty[];
  search_metadata?: { google_hotels_url?: string };
};

const RATING_TO_NUMERIC: Record<string, string> = {
  "3.5": "7",
  "4.0": "8",
  "4.5": "9"
};

function formatHotel(p: HotelProperty, index: number): string {
  const price = p.rate_per_night?.lowest ?? "?";
  const total = p.total_rate?.lowest;
  const stars = p.hotel_class ? ` ${p.hotel_class}` : "";
  const rating =
    p.overall_rating !== undefined
      ? ` ${p.overall_rating}/5${p.reviews ? ` (${p.reviews} reviews)` : ""}`
      : "";
  const amenities = (p.amenities ?? []).slice(0, 4).join(", ");
  const link = p.link ? `\n   ${p.link}` : "";
  return (
    `${index + 1}. ${p.name ?? "?"}${stars}${rating}\n` +
    `   ${price}/night${total ? ` (${total} total)` : ""}` +
    (amenities ? `\n   ${amenities}` : "") +
    link
  );
}

const hotelSearchTool = defineTool({
  name: "hotel_search",
  label: "Search Google Hotels",
  description:
    "Search Google Hotels via SerpAPI. Returns hotel options with price per night, rating, class, and amenities. Prices are snapshots and not bookable.",
  promptSnippet:
    "hotel_search: query Google Hotels for stays in a location across given dates. Snapshot prices only.",
  parameters: hotelSearchParams,
  async execute(_id, params: Static<typeof hotelSearchParams>, signal) {
    const currency = params.currency ?? "USD";
    const data = (await serpApiRequest(
      {
        engine: "google_hotels",
        q: params.q,
        check_in_date: params.check_in_date,
        check_out_date: params.check_out_date,
        adults: params.adults ?? 2,
        children: params.children ?? 0,
        currency,
        min_price: params.min_price,
        max_price: params.max_price,
        rating: params.rating ? RATING_TO_NUMERIC[params.rating] : undefined,
        hl: "en",
        gl: "us"
      },
      signal
    )) as HotelSearchResult;

    const properties = (data.properties ?? []).slice(0, 8);
    const url = data.search_metadata?.google_hotels_url;
    const searchedAt = new Date().toISOString();

    const blocks: string[] = [];
    if (properties.length) {
      blocks.push(properties.map((p, i) => formatHotel(p, i)).join("\n\n"));
    } else {
      blocks.push("No hotels found.");
    }
    if (url) blocks.push(`Open on Google Hotels: ${url}`);
    blocks.push(`(searched_at: ${searchedAt} - prices are snapshots, not bookable)`);

    return {
      content: [{ type: "text", text: blocks.join("\n\n") }],
      details: { count: properties.length }
    };
  }
});

/**
 * SerpAPI-backed flight and hotel search. Requires SERPAPI_API_KEY.
 * No public Google Flights/Hotels API exists; SerpAPI is the standard shim.
 */
export function createTravelTools(): ToolDefinition[] {
  if (!process.env.SERPAPI_API_KEY?.trim()) {
    return [];
  }
  return [flightSearchTool, hotelSearchTool];
}
