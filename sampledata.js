// Sample odds fixture, kept in sample-data.json so it can be inspected/refreshed
// without touching code. Fetched at runtime (never costs API credits); usage is
// null because sample data doesn't hit the Odds API.
//
// The URL is resolved relative to this module (not the page) so the fetch works
// from any hosting path — including GitHub Pages project sites.
export default async function getSampleData() {
  const response = await fetch(new URL('./sample-data.json', import.meta.url));
  if (!response.ok) {
    throw new Error(`Failed to load sample data: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return { data, usage: null };
}
