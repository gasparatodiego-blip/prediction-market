import { NextResponse } from 'next/server';
import fs from 'fs';

const WEATHER_FILE = '/tmp/weather-markets.json';

export interface WeatherMarket {
  id:           string;
  title:        string;
  subtitle:     string;
  category:     string;
  probability:  number | null;
  yesPrice:     number | null;
  noPrice:      number | null;
  volume:       number | null;
  openInterest: number | null;
  expiresAt:    string | null;
  url:          string;
  source:       string;
}

export interface ForecastDay {
  date:          string;
  maxTempF:      number | null;
  minTempF:      number | null;
  precipIn:      number | null;
  precipProbPct: number | null;
  maxWindMph:    number | null;
}

export interface CityForecast {
  city: string;
  lat:  number;
  lon:  number;
  days: ForecastDay[];
}

export interface WeatherResponse {
  markets:      WeatherMarket[];
  forecasts:    CityForecast[];
  totalMarkets: number;
  fetchedAt:    number;
  dataAge:      number;
}

export async function GET() {
  try {
    const raw  = fs.readFileSync(WEATHER_FILE, 'utf8');
    const data = JSON.parse(raw);
    const dataAge = Date.now() - (data.fetchedAt ?? 0);
    return NextResponse.json({ ...data, dataAge } as WeatherResponse);
  } catch {
    return NextResponse.json({
      markets: [], forecasts: [], totalMarkets: 0,
      fetchedAt: 0, dataAge: 999_999_999,
    } as WeatherResponse);
  }
}
