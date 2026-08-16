import { cookies } from "next/headers";
import LandingClient from "./LandingClient";

// Server wrapper: read the theme cookie so the landing's JS palette is chosen
// during SSR and matches the <html data-theme> the root layout sets — the night
// landing paints dark on the first frame with no flash. Default day.
export default function Page() {
  const theme = cookies().get("theme")?.value === "night" ? "night" : "day";
  return <LandingClient initialTheme={theme} />;
}
