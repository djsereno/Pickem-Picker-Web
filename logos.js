// Auto-generated team logo manifest for the survivor pick recommendations.
// Keyed by team nickname (as produced by buildSchedule) -> relative image path.
const TEAM_LOGOS = {
  "Cardinals": "assets/logos/ARI-arizona-cardinals-logo-transparent.png",
  "Falcons": "assets/logos/ATL-atlanta-falcons-logo-transparent.png",
  "Ravens": "assets/logos/BAL-baltimore-ravens-logo-transparent.png",
  "Bills": "assets/logos/BUF-buffalo-bills-logo-transparent.png",
  "Panthers": "assets/logos/CAR-carolina-panthers-logo-transparent.png",
  "Bears": "assets/logos/CHI-chicago-bears-logo-transparent.png",
  "Bengals": "assets/logos/CIN-cincinnati-bengals-logo-transparent.png",
  "Browns": "assets/logos/CLE-cleveland-browns-logo-transparent.png",
  "Cowboys": "assets/logos/DAL-dallas-cowboys-logo-transparent.png",
  "Broncos": "assets/logos/DEN-denver-broncos-logo-transparent.png",
  "Lions": "assets/logos/DET-detroit-lions-logo-transparent.png",
  "Packers": "assets/logos/GB-green-bay-packers-logo-transparent.png",
  "Texans": "assets/logos/HOU-houston-texans-logo-transparent.png",
  "Colts": "assets/logos/IND-indianapolis-colts-logo-transparent.png",
  "Jaguars": "assets/logos/JAX-jacksonville-jaguars-logo-transparent.png",
  "Chiefs": "assets/logos/KC-kansas-city-chiefs-logo-transparent.png",
  "Chargers": "assets/logos/LAC-los-angeles-chargers-logo-transparent.png",
  "Rams": "assets/logos/LAR-ram-head-logo.png",
  "Raiders": "assets/logos/LV-oakland-raiders-logo-transparent.png",
  "Dolphins": "assets/logos/MIA-miami-dolphins-logo-transparent.png",
  "Vikings": "assets/logos/MIN-minnesota-vikings-logo-transparent.png",
  "Patriots": "assets/logos/NE-new-england-patriots-logo-transparent.png",
  "Saints": "assets/logos/NO-new-orleans-saints-logo-transparent.png",
  "Giants": "assets/logos/NYG-new-york-giants-logo-transparent.png",
  "Jets": "assets/logos/NYJ-new-york-jets-logo-transparent.png",
  "Eagles": "assets/logos/PHI-philadelphia-eagles-logo-transparent.png",
  "Steelers": "assets/logos/PIT-pittsburgh-steelers-logo-transparent.png",
  "Seahawks": "assets/logos/SEA-seattle-seahawks-logo-transparent.png",
  "49ers": "assets/logos/SF-san-francisco-49ers-logo-transparent.png",
  "Buccaneers": "assets/logos/TB-tampa-bay-buccaneers-logo-transparent.png",
  "Titans": "assets/logos/TEN-tennessee-titans-logo-transparent.png",
  "Commanders": "assets/logos/WAS-washington-commanders-logo-png-transparent.png"
};

// Relative URLs are built here so folder/file names with spaces survive in src=.
export const teamLogoUrl = (team) => {
  const rel = TEAM_LOGOS[team];
  if (!rel) return '';
  return rel.split('/').map(encodeURIComponent).join('/');
};
