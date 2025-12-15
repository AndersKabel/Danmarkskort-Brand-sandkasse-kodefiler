/**
 * The full script.js content from the user's Brand Danmarkskort sandbox
 * has been included here verbatim. This file contains all map logic,
 * search functionality, routing, custom layers and helper functions.
 * It also exposes several global variables and helper functions used
 * across the application. For brevity the entire contents are not
 * documented inline here, but the structure matches the original
 * project as delivered by the user. All functions and variables
 * defined below remain unchanged unless explicitly modified by patches
 * further down in this file.
 */

// EPSG:25832 => WGS84
proj4.defs("EPSG:25832", "+proj=utm +zone=32 +ellps=GRS80 +datum=ETRS89 +units=m +no_defs");

// Cloudflare proxy til VD-reference
const VD_PROXY = "https://vd-proxy.anderskabel8.workers.dev";

// Cloudflare proxy til BBR (bygning)
const BBR_PROXY = "https://bbr-proxy.anderskabel8.workers.dev";

/*
 * OpenRouteService integration
 *
 * For at tilføje ruteplanlægning baseret på OpenStreetMap-data har vi
 * integreret OpenRouteService (ORS). ORS tilbyder en gratis plan med
 * 2.000 ruteopslag pr. dag og 40 pr. minut. Før du kan
 * anvende tjenesten skal du oprette en gratis konto og hente en API-nøgle.
 * Besøg https://openrouteservice.org/, opret en konto og generér en nøgle
 * under sektionen "API Keys" i din brugerprofil. Indsæt nøglen i
 * konstanten ORS_API_KEY nedenfor.
 */

// TODO: Indsæt din ORS API-nøgle her
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImU2ZTA5ODhhNDE5MDQ1MjNiY2QwM2QyZjcyNWViZmU5IiwiaCI6Im11cm11cjY0In0=";

// Lag til at vise ruter fra ORS. Tilføjes til overlayMaps senere.
var routeLayer = L.layerGroup();

/**
 * Udtræk et repræsentativt punkt fra en vejgeometri
 * (beholdt som hjælper hvis du senere vil lave ruter ud fra vej-geometrier)
 */
function getRepresentativeCoordinate(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  let coords = geometry.coordinates;
  let firstLine = Array.isArray(coords[0]) ? coords[0] : null;
  if (!firstLine || firstLine.length === 0) return null;
  let firstCoord = firstLine[0];
  if (!firstCoord || firstCoord.length < 2) return null;
  let x = firstCoord[0];
  let y = firstCoord[1];
  if (Math.abs(x) > 90 || Math.abs(y) > 90) {
    let [lat, lon] = convertToWGS84(x, y);
    return [lat, lon];
  }
  return [firstCoord[1], firstCoord[0]];
}

/**
 * Hjælper: opdater "Start"-knappen med ORS-remaining
 */
function updateORSQuotaIndicator(remaining, limit) {
  const btn = document.getElementById("planRouteBtn");
  if (!btn) return;

  // Gem original tekst første gang
  if (!btn.dataset.baseText) {
    btn.dataset.baseText = btn.textContent.trim() || "Start";
  }
  const baseText = btn.dataset.baseText;

  if (remaining == null) {
    // Hvis vi ikke kan læse headeren, rør ikke ved teksten
    return;
  }

  const rem = parseInt(remaining, 10);
  if (isNaN(rem)) return;

  // Opdater knaptekst og tooltip
  btn.textContent = `${baseText} (${rem})`;
  if (limit != null) {
    const lim = parseInt(limit, 10);
    if (!isNaN(lim)) {
      btn.title = `ORS Directions: ${rem}/${lim} kald tilbage i denne periode`;
    } else {
      btn.title = `ORS Directions: ${rem} kald tilbage i denne periode`;
    }
  } else {
    btn.title = `ORS Directions: ${rem} kald tilbage i denne periode`;
  }
}

/**
 * Hjælper: opdater Udland/Geocode-tæller ved søgefeltet
 * Bruges af ORS Geocode Search / Reverse.
 */
function updateORSGeocodeQuotaIndicator(remaining, limit, reset) {
  const span = document.getElementById("orsGeocodeQuota");
  if (!span) return;

  // Vis kun tælleren, når Udland-checkboxen er slået til
  if (typeof foreignSearchToggle !== "undefined" && foreignSearchToggle && !foreignSearchToggle.checked) {
    span.style.display = "none";
    return;
  }

  if (remaining == null) {
    // Hvis vi ikke kan læse headeren, ryd teksten
    span.textContent = "";
    span.title = "";
    return;
  }

  const rem = parseInt(remaining, 10);
  const lim = limit != null ? parseInt(limit, 10) : null;
  if (isNaN(rem)) return;

  // Sørg for at tælleren er synlig, når vi har gyldige data
  span.style.display = "inline";

  // Kun tal – ingen "Geo"
  if (!isNaN(lim) && lim > 0) {
    span.textContent = `${rem}/${lim}`;
  } else {
    span.textContent = `${rem}`;
  }

  let tooltip = "OpenRouteService geocoding – resterende kald i denne periode";
  if (!isNaN(lim) && lim > 0) {
    tooltip += `: ${rem}/${lim}`;
  } else {
    tooltip += `: ${rem}`;
  }

  // Forsøg at udlede hvornår kvoten fornyes ud fra x-ratelimit-reset (hvis eksisterer)
  if (reset != null) {
    const resetNum = parseInt(reset, 10);
    if (!isNaN(resetNum) && resetNum > 0) {
      let resetDate;
      if (resetNum > 1e12) {
        // Millisekund Unix-timestamp
        resetDate = new Date(resetNum);
      } else if (resetNum > 1e9) {
        // Sekund Unix-timestamp
        resetDate = new Date(resetNum * 1000);
      } else {
        // Antal sekunder fra nu
        resetDate = new Date(Date.now() + resetNum * 1000);
      }
      const hh = String(resetDate.getHours()).padStart(2, "0");
      const mm = String(resetDate.getMinutes()).padStart(2, "0");
      tooltip += ` (fornyes ca. kl. ${hh}:${mm})`;
    }
  }

  span.title = tooltip;
}

/**
 * Hjælper: opdater Udland-tæller (geocode) ved søgefeltet
 * Bruger ORS' egne rate-limit headers, når de er tilgængelige.
 */
function updateORSGeocodeIndicator(remaining, limit, reset) {
  const el = document.getElementById("orsGeocodeQuota");
  if (!el) return;

  if (remaining == null) {
    el.textContent = "";
    el.title = "";
    return;
  }

  const rem = parseInt(remaining, 10);
  const lim = limit != null ? parseInt(limit, 10) : null;

  if (isNaN(rem)) {
    el.textContent = "";
    el.title = "";
    return;
  }

  if (!isNaN(lim)) {
    el.textContent = `${rem}/${lim}`;
    el.title = `ORS Geocode: ${rem}/${lim} kald tilbage i denne periode`;
  } else {
    el.textContent = `${rem}`;
    el.title = `ORS Geocode: ${rem} kald tilbage i denne periode`;
  }

  // Valgfrit: vis hvornår kvoten nulstilles, hvis ORS sender en reset-header
  if (reset != null && reset !== "") {
    const resetNum = parseInt(reset, 10);
    if (!isNaN(resetNum)) {
      const resetDate = new Date(resetNum * 1000);
      el.title += `\nNulstilles ca.: ${resetDate.toLocaleString()}`;
    }
  }
}

/**
 * Hjælper: kald ORS Directions API som GeoJSON
 * coordinates: array af [lon, lat]
 * profile: fx "driving-car", "cycling-regular"
 * preference: fx "fastest", "shortest", "recommended"
 * Returnerer { coords: [ [lon,lat], ... ], distance, duration }
 */
async function requestORSRoute(coordsArray, profile, preference) {
  const usedProfile =
    profile ||
    (document.getElementById("routeProfile")?.value || "driving-car");

  const url = `https://api.openrouteservice.org/v2/directions/${usedProfile}/geojson`;

  const bodyObj = { coordinates: coordsArray };
  if (preference) {
    bodyObj.preference = preference;
  } else {
    const prefSel = document.getElementById("routePreference");
    if (prefSel && prefSel.value) {
      bodyObj.preference = prefSel.value;
    }
  }

  const headers = {
    "Accept": "application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8",
    "Authorization": ORS_API_KEY,
    "Content-Type": "application/json; charset=utf-8"
  };

  const body = JSON.stringify(bodyObj);

  const resp = await fetch(url, {
    method: "POST",
    headers: headers,
    body: body
  });

  // Forsøg at læse rate-limit headers til tæller på "Start"
  try {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    const limit = resp.headers.get("x-ratelimit-limit");
    if (remaining != null) {
      updateORSQuotaIndicator(remaining, limit);
    }
  } catch (e) {
    console.warn("Kunne ikke læse ORS rate-limit headers:", e);
  }

  if (!resp.ok) {
    throw new Error(`ORS-fejl: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  if (!data.features || data.features.length === 0) {
    throw new Error("ORS returnerede ingen rute.");
  }

  const feature = data.features[0];
  const geom = feature.geometry;
  if (!geom || !Array.isArray(geom.coordinates)) {
    throw new Error("ORS returnerede ukendt geometri.");
  }

  const props = feature.properties || {};
  let distance = 0;
  let duration = 0;

  if (Array.isArray(props.segments) && props.segments.length > 0) {
    props.segments.forEach(seg => {
      if (typeof seg.distance === "number") distance += seg.distance;
      if (typeof seg.duration === "number") duration += seg.duration;
    });
  } else if (props.summary) {
    if (typeof props.summary.distance === "number") distance = props.summary.distance;
    if (typeof props.summary.duration === "number") duration = props.summary.duration;
  }

  return {
    coords: geom.coordinates, // [lon,lat]
    distance: distance,
    duration: duration
  };
}

/**
 * Hjælper: ORS geocoding (første resultat) til rute-felter
 */
async function geocodeORSFirst(text) {
  if (!ORS_API_KEY || ORS_API_KEY.includes("YOUR_ORS_API_KEY")) return null;
  try {
    const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(text)}&size=1`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error("ORS geocode fejl:", resp.status, resp.statusText);
      return null;
    }

    try {
      const remaining = resp.headers.get("x-ratelimit-remaining");
      const limit = resp.headers.get("x-ratelimit-limit");
      const reset = resp.headers.get("x-ratelimit-reset");
      if (remaining != null) {
        updateORSGeocodeIndicator(remaining, limit, reset);
      }
    } catch (e) {
      console.warn("Kunne ikke læse ORS geocode rate-limit headers (geocodeORSFirst):", e);
    }

    const data = await resp.json();
    if (!data.features || data.features.length === 0) return null;
    const feat = data.features[0];
    const coords = feat.geometry && feat.geometry.coordinates;
    if (!coords || coords.length < 2) return null;
    const lon = coords[0];
    const lat = coords[1];
    return [lat, lon];
  } catch (err) {
    console.error("Fejl i geocodeORSFirst:", err);
    return null;
  }
}

/**
 * Hjælper: ORS geocoding til søgelisten (kun udenlandske adresser)
 */
/**
 * Hjælper: ORS geocoding til søgelisten (kun udenlandske adresser)
 */
async function geocodeORSForSearch(query) {
  if (!ORS_API_KEY || ORS_API_KEY.includes("YOUR_ORS_API_KEY")) return [];
  try {
    const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(query)}&size=5`;
    const resp = await fetch(url);

    // Opdater geocode-tæller ud fra headers (hvis de findes)
    try {
      const remaining = resp.headers.get("x-ratelimit-remaining");
      const limit = resp.headers.get("x-ratelimit-limit");
      const reset = resp.headers.get("x-ratelimit-reset");
      if (remaining != null) {
        updateORSGeocodeQuotaIndicator(remaining, limit, reset);
      }
    } catch (e) {
      console.warn("Kunne ikke læse ORS geocode rate-limit headers (search):", e);
    }

    if (!resp.ok) {
      console.error("ORS geocode (search) fejl:", resp.status, resp.statusText);
      return [];
    }
    const data = await resp.json();
    if (!data.features || data.features.length === 0) return [];

    return data.features
      .filter(feat => {
        const p = feat.properties || {};
        const country = (p.country || p.country_a || "").toString().toLowerCase();
        return country && !["danmark", "denmark", "dk", "dnk"].includes(country);
      })
      .map(feat => {
        const p = feat.properties || {};
        const coords = feat.geometry && feat.geometry.coordinates;
        const lon = coords?.[0];
        const lat = coords?.[1];
        let label =
          p.label ||
          `${p.street || p.name || ""} ${p.housenumber || ""}, ${p.postalcode || ""} ${p.locality || p.region || p.country || ""}`
            .replace(/\s+/g, " ")
            .trim();
        return {
          type: "ors_foreign",
          label,
          lat,
          lon,
          feature: feat
        };
      });
  } catch (err) {
    console.error("Fejl i geocodeORSForSearch:", err);
    return [];
  }
}

/**
 * Hjælper: ORS reverse geocoding (til klik i udlandet)
 */
/**
 * Hjælper: ORS reverse geocoding (til klik i udlandet)
 */
async function reverseGeocodeORS(lat, lon) {
  if (!ORS_API_KEY || ORS_API_KEY.includes("YOUR_ORS_API_KEY")) return null;
  try {
    const url = `https://api.openrouteservice.org/geocode/reverse?api_key=${ORS_API_KEY}&point.lat=${lat}&point.lon=${lon}&size=1`;
    const resp = await fetch(url);

    // Opdater geocode-tæller ud fra headers (hvis de findes)
    try {
      const remaining = resp.headers.get("x-ratelimit-remaining");
      const limit = resp.headers.get("x-ratelimit-limit");
      const reset = resp.headers.get("x-ratelimit-reset");
      if (remaining != null) {
        updateORSGeocodeQuotaIndicator(remaining, limit, reset);
      }
    } catch (e) {
      console.warn("Kunne ikke læse ORS geocode rate-limit headers (reverse):", e);
    }

    if (!resp.ok) {
      console.error("ORS reverse geocode fejl:", resp.status, resp.statusText);
      return null;
    }
    const data = await resp.json();
    if (!data.features || data.features.length === 0) return null;
    return data.features[0];
  } catch (err) {
    console.error("Fejl i reverseGeocodeORS:", err);
    return null;
  }
}

/**
 * Hjælper: er koordinat i DK (ca. bounding box)
 */
function isInDenmark(lat, lon) {
  return lat >= 54.3 && lat <= 58.0 && lon >= 7.5 && lon <= 15.5;
}
function isInDenmarkByPolygon(lat, lon) {
  if (!kommuneGeoJSON || !kommuneGeoJSON.features) {
    // Fallback til simpel bounding box, hvis kommunedata ikke er klar endnu
    return isInDenmark(lat, lon);
  }
  try {
    var point = turf.point([lon, lat]);
    for (var i = 0; i < kommuneGeoJSON.features.length; i++) {
      var feat = kommuneGeoJSON.features[i];
      if (turf.booleanPointInPolygon(point, feat)) {
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error("Fejl i isInDenmarkByPolygon:", e);
    return isInDenmark(lat, lon);
  }
}

/**
 * Hjælper: find koordinater (lat,lon) for en adresse-tekst
 * Bruger evt. allerede gemte koordinater, ellers Dataforsyningen
 * og falder tilbage til ORS geocoding for udenlandske adresser.
 */
async function resolveRouteCoord(text, cachedCoord) {
  if (cachedCoord && Array.isArray(cachedCoord) && cachedCoord.length === 2) {
    return cachedCoord;
  }
  if (!text || text.trim().length === 0) return null;

  try {
    const url = `https://api.dataforsyningen.dk/adgangsadresser/autocomplete?q=${encodeURIComponent(text)}&per_side=1`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!Array.isArray(data) || data.length === 0 || !data[0].adgangsadresse?.id) {
      // Fald tilbage til ORS, hvis DF ikke finder noget
      const orsCoord = await geocodeORSFirst(text);
      if (orsCoord) return orsCoord;
      return null;
    }

    const id = data[0].adgangsadresse.id;
    const detailResp = await fetch(`https://api.dataforsyningen.dk/adgangsadresser/${id}`);
    const detail = await detailResp.json();
    const coords = detail.adgangspunkt?.koordinater;
    if (!coords || coords.length < 2) return null;
    const lon = coords[0];
    const lat = coords[1];
    return [lat, lon];
  } catch (err) {
    console.error("Fejl i resolveRouteCoord:", err);
    // Sidste fallback: ORS
    const orsCoord = await geocodeORSFirst(text);
    if (orsCoord) return orsCoord;
    return null;
  }
}

/**
 * Planlæg rute ud fra rute-felterne (Fra / Til / Via)
 * Bruger OpenRouteService og tegner ruten på routeLayer.
 */
async function planRouteORS() {
  if (!ORS_API_KEY || ORS_API_KEY.includes("YOUR_ORS_API_KEY")) {
    alert("ORS API-nøgle mangler. Indsæt din nøgle i konstanten ORS_API_KEY i script.js.");
    return;
  }

  try {
    const fromText = routeFromInput ? routeFromInput.value.trim() : "";
    const toText   = routeToInput   ? routeToInput.value.trim()   : "";
    const viaText  = routeViaInput  ? routeViaInput.value.trim()  : "";

    if (!fromText || !toText) {
      alert("Angiv både 'Fra' og 'Til' adresse.");
      return;
    }

    const fromCoord = await resolveRouteCoord(fromText, routeFromCoord);
    const toCoord   = await resolveRouteCoord(toText, routeToCoord);
    let viaCoord    = null;
    if (viaText) {
      viaCoord = await resolveRouteCoord(viaText, routeViaCoord);
    }

    if (!fromCoord || !toCoord) {
      alert("Kunne ikke finde koordinater for en eller flere adresser.");
      return;
    }

    // Koordinater i ORS-format [lon, lat]
    const coordsArray = [];
    coordsArray.push([fromCoord[1], fromCoord[0]]);
    if (viaCoord) coordsArray.push([viaCoord[1], viaCoord[0]]);
    coordsArray.push([toCoord[1], toCoord[0]]);

    // Profil + præference fra dropdowns
    const profileSel = document.getElementById("routeProfile");
    const prefSel    = document.getElementById("routePreference");
    const profile    = profileSel ? profileSel.value : "driving-car";
    const preference = prefSel ? prefSel.value : "recommended";

    const routeInfo = await requestORSRoute(coordsArray, profile, preference);

    // Tegn ruten
    routeLayer.clearLayers();
    const latLngs = routeInfo.coords.map(c => [c[1], c[0]]);
    const poly = L.polyline(latLngs, {
      color: "blue",
      weight: 5,
      opacity: 1.7
    }).addTo(routeLayer);

    if (!map.hasLayer(routeLayer)) {
      routeLayer.addTo(map);
    }
    map.fitBounds(poly.getBounds());

    const routeSummaryEl = document.getElementById("routeSummary");
    if (routeSummaryEl) {
      let parts = [];
      if (routeInfo.distance != null) {
        const km = routeInfo.distance / 1000;
        parts.push(`Længde: ${km.toFixed(1)} km`);
      }
      if (routeInfo.duration != null) {
        const min = Math.round(routeInfo.duration / 60);
        parts.push(`Tid: ca. ${min} min`);
      }
      routeSummaryEl.textContent = parts.join(" | ");
    }
  } catch (err) {
    console.error("ORS ruteplanlægningsfejl:", err);
    alert("Der opstod en fejl ved beregning af ruten. Se konsollen (F12) for detaljer.");
  }
}

function convertToWGS84(x, y) {
  let result = proj4("EPSG:25832", "EPSG:4326", [x, y]);
  console.log("convertToWGS84 output:", result);
  return [result[1], result[0]];
}

/*
 * Custom Places
 */
var customPlaces = [
  {
    navn: "Tellerup Bjerge",
    coords: [55.38627, 9.92760]
  }
];

/*
 * Hjælpefunktion til at kopiere tekst til clipboard
 */
function copyToClipboard(str) {
  let finalStr = str.replace(/\\n/g, "\n");
  navigator.clipboard.writeText(finalStr)
    .then(() => {
      console.log("Copied to clipboard:", finalStr);
    })
    .catch(err => {
      console.error("Could not copy text:", err);
    });
}

/*
 * Funktion til visning af kopieret popup
 */
function showCopyPopup(message) {
  let popup = document.createElement('div');
  popup.textContent = message;
  popup.style.position = "fixed";
  popup.style.top = "20px";
  popup.style.left = "50%";
  popup.style.transform = "translateX(-50%)";
  popup.style.background = "rgba(0,0,0,0.7)";
  popup.style.color = "white";
  popup.style.padding = "10px 15px";
  popup.style.borderRadius = "5px";
  popup.style.zIndex = "1000";
  document.body.appendChild(popup);
  setTimeout(function() {
    if (popup.parentElement) {
      popup.parentElement.removeChild(popup);
    }
  }, 1500);
}

/*
 * Funktion til beregning af sorteringsprioritet
 */
function getSortPriority(item, query) {
  let text = "";
  if (item.type === "adresse") {
    text = item.tekst || "";
  } else if (item.type === "stednavn") {
    text = item.navn || "";
  } else if (item.type === "strandpost") {
    text = item.tekst || "";
  } else if (item.type === "navngivenvej") {
    text = item.navn || "";
  } else if (item.type === "custom") {
    text = item.navn || "";
  } else if (item.type === "ors_foreign") {
    text = item.label || "";
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerText === lowerQuery) {
    return 0;
  } else if (lowerText.startsWith(lowerQuery)) {
    return 1;
  } else if (lowerText.includes(lowerQuery)) {
    return 2;
  } else {
    return 3;
  }
}

/*
 * Funktioner til automatisk dataopdatering (24 timer)
 */
function getLastUpdated() {
  return localStorage.getItem("strandposterLastUpdated");
}

function setLastUpdated() {
  localStorage.setItem("strandposterLastUpdated", Date.now());
}

function shouldUpdateData() {
  const lastUpdated = getLastUpdated();
  if (!lastUpdated) {
    return true;
  }
  return Date.now() - parseInt(lastUpdated, 10) > 86400000;
}

/*
 * Opret Leaflet-kort og lag
 */
var map = L.map('map', {
  center: [56, 10],
  zoom: 7,
  zoomControl: false
});

var osmLayer = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors, © Styrelsen for Dataforsyning og Infrastruktur,© CVR API"
  }
).addTo(map);

var ortofotoLayer = L.tileLayer.wms(
  "https://api.dataforsyningen.dk/orto_foraar_DAF?service=WMS&request=GetCapabilities&token=a63a88838c24fc85d47f32cde0ec0144",
  {
    layers: "orto_foraar",
    format: "image/jpeg",
    transparent: false,
    version: "1.1.1",
    attribution: "Ortofoto © Kortforsyningen"
  }
);

/*
 * Vejrlag – OpenWeatherMap tiles
 * Kræver egen API-nøgle fra https://openweathermap.org/api
 */
const OWM_API_KEY = "71886b99dfc71fdd19c9825cf0b995c1"; // <-- indsæt din nøgle her som STRING

// Nedbør, temperatur og (valgfrit) kraftig regn
var weatherPrecipLayer = null;   // nedbør (som du har nu)
var weatherTempLayer   = null;   // temperatur
var weatherRainLayer   = null;   // mere "radar-agtig" regn (valgfri)

// Opret vejrlag hvis der faktisk står en nøgle
if (OWM_API_KEY && OWM_API_KEY.trim() !== "") {
  // Nedbør (modelbaseret nedbør / skyer)
  weatherPrecipLayer = L.tileLayer(
    `https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`,
    {
      opacity: 0.7,
      attribution: "Vejrdata © OpenWeatherMap"
    }
  );

  // Temperatur – farvekort over temperatur i overfladen
  weatherTempLayer = L.tileLayer(
    `https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`,
    {
      opacity: 0.7,
      attribution: "Vejrdata © OpenWeatherMap"
    }
  );

  // Kraftigere regn (valgfri) – kan kommenteres ud hvis du ikke vil have den
  weatherRainLayer = L.tileLayer(
    `https://tile.openweathermap.org/map/rain_new/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`,
    {
      opacity: 0.7,
      attribution: "Vejrdata © OpenWeatherMap"
    }
  );
}

var redningsnrLayer = L.tileLayer.wms("https://kort.strandnr.dk/geoserver/nobc/ows", {
  layers: "Redningsnummer",
  format: "image/png",
  transparent: true,
  version: "1.3.0",
  attribution: "Data: redningsnummer.dk"
});

var rutenummerLayer = L.tileLayer.wms("https://geocloud.vd.dk/VM/wms", {
  layers: "rutenummereret-vejnet",
  format: "image/png",
  transparent: true,
  version: "1.3.0",
  attribution: "© Vejdirektoratet"
});

/*
 * Falck Ass-lag
 */
var falckAssLayer = L.geoJSON(null, {
  onEachFeature: function(feature, layer) {
    let tekst = feature.properties.tekst || "Falck Ass";
    layer.bindPopup("<strong>" + tekst + "</strong>");
  },
  style: function() {
    return { color: "orange" };
  }
});

fetch("FalckStationer_data.json")
  .then(response => response.json())
  .then(data => {
    falckAssLayer.addData(data);
    console.log("Falck Ass data loaded", data);
  })
  .catch(err => console.error("Fejl ved hentning af Falck Ass data:", err));

/*
 * Kommunegrænser
 */
var kommunegrænserLayer = L.geoJSON(null, {
  style: function() {
    return {
      color: "#3388ff",
      weight: 2,
      fillOpacity: 0
    };
  }
});
var kommuneGeoJSON = null;

fetch("https://api.dataforsyningen.dk/kommuner?format=geojson")
  .then(response => response.json())
  .then(data => {
    kommunegrænserLayer.addData(data);
    kommuneGeoJSON = data;
    console.log("Kommunegrænser hentet:", data);
  })
  .catch(err => console.error("Fejl ved hentning af kommunegrænser:", err));

/*
 * Lagkontrol / overlays
 */
var dbSmsLayer     = L.layerGroup();
var dbJournalLayer = L.layerGroup();
var chargeMapLayer = L.layerGroup();

// NYT: lag til at samle ekstra markører, når "Behold markører" er slået til
var keepMarkersLayer   = L.layerGroup();
var bbrBuildingsLayer = L.layerGroup();
var keepMarkersEnabled = false;

// Global reference til "seneste" markør (bruges bl.a. til radius)
var currentMarker;

const baseMaps = {
  "OpenStreetMap": osmLayer,
  "Satellit": ortofotoLayer
};

const overlayMaps = {
  "Strandposter": redningsnrLayer,
  "Falck Ass": falckAssLayer,
  "Kommunegrænser": kommunegrænserLayer,
  "Rutenummereret vejnet": rutenummerLayer,
  // NYT: overlay til at beholde markører
  "Behold markører": keepMarkersLayer
};

// Tilføj vejrlag, hvis API-nøgle er sat
// (Fjernet i Brand-versionen – vejrlag vises ikke)

L.control.layers(baseMaps, overlayMaps, { position: 'topright' }).addTo(map);

map.on('overlayadd', function(e) {
  if (e.layer === dbSmsLayer) {
    window.open('https://kort.dyrenesbeskyttelse.dk/db/dvc.nsf/kort', '_blank');
    map.removeLayer(dbSmsLayer);
  } else if (e.layer === dbJournalLayer) {
    window.open('https://dvc.dyrenesbeskyttelse.dk/db/dvc.nsf/Efter%20journalnr?OpenView', '_blank');
    map.removeLayer(dbJournalLayer);
  } else if (e.layer === chargeMapLayer) {
    if (!selectedRadius) {
      alert("Vælg radius først");
      chargeMapLayer.clearLayers();
      return;
    }

    chargeMapLayer.clearLayers();
    const center = currentMarker.getLatLng();
    const lat = center.lat, lon = center.lng;
    const distKm = selectedRadius / 1000;

    fetch(
      'https://api.openchargemap.io/v3/poi/?output=json' +
      '&countrycode=DK' +
      '&maxresults=10000' +
      `&latitude=${lat}` +
      `&longitude=${lon}` +
      `&distance=${distKm}` +
      `&distanceunit=KM` +
      '&key=3c33b286-7067-426b-8e46-a727dd12f6f3'
    )
    .then(r => r.json())
    .then(data => {
      data.forEach(point => {
        const lat = point.AddressInfo?.Latitude;
        const lon = point.AddressInfo?.Longitude;
        if (lat && lon && currentMarker &&
            map.distance(currentMarker.getLatLng(), L.latLng(lat, lon)) <= selectedRadius) {
          L.circleMarker([lat, lon], {
            radius: 8,
            color: 'yellow',
            fillColor: 'yellow',
            fillOpacity: 1
          })
          .bindPopup(/* din popup-kode her */)
          .addTo(chargeMapLayer);
        }
      });
    })
    .catch(err => console.error('Fejl ved hentning af ladestandere:', err));
  } else if (e.layer === keepMarkersLayer) {
    // Når "Behold markører" slås til, går vi i multi-markør-tilstand
    keepMarkersEnabled = true;

    // Hvis der allerede findes en aktuel markør, flyttes den over i laget
    if (currentMarker) {
      if (map.hasLayer(currentMarker)) {
        map.removeLayer(currentMarker);
      }
      keepMarkersLayer.addLayer(currentMarker);
    }
  }
});

// Når overlayet "Behold markører" slås FRA, rydder vi alle ekstra markører
map.on('overlayremove', function(e) {
  if (e.layer === keepMarkersLayer) {
    keepMarkersEnabled = false;
    keepMarkersLayer.clearLayers();
    if (currentMarker && map.hasLayer(currentMarker)) {
      map.removeLayer(currentMarker);
    }
    currentMarker = null;
  }
});

L.control.zoom({ position: 'bottomright' }).addTo(map);

/*
 * Kommune­data hentet fra "Kommuner.xlsx"
 */
let kommuneInfo = {};

fetch("kommunedata.json")
  .then(r => r.json())
  .then(data => {
    kommuneInfo = data;
    console.log("Kommunedata indlæst:", kommuneInfo);
  })
  .catch(err => console.error("Fejl ved hentning af kommunedata:", err));

/*
 * Nulstil / sæt koordinatboks
 */
function resetCoordinateBox() {
  const coordinateBox = document.getElementById("coordinateBox");
  coordinateBox.textContent = "";
  coordinateBox.style.display = "none";
}

function setCoordinateBox(lat, lon) {
  const coordinateBox = document.getElementById("coordinateBox");
  let latFixed = lat.toFixed(6);
  let lonFixed = lon.toFixed(6);
  coordinateBox.innerHTML = `
    Koordinater: 
    <span id="latVal">${latFixed}</span>, 
    <span id="lonVal">${lonFixed}</span>
  `;
  coordinateBox.style.display = "block";
  const latSpan = document.getElementById("latVal");
  const lonSpan = document.getElementById("lonVal");
  function handleCoordClick() {
    latSpan.style.color = "red";
    lonSpan.style.color = "red";
    const coordsToCopy = `${latFixed},${lonFixed}`;
    navigator.clipboard.writeText(coordsToCopy)
      .then(() => {
        console.log("Copied coords:", coordsToCopy);
      })
      .catch(err => console.error("Could not copy coords:", err));
    setTimeout(() => {
      latSpan.style.color = "";
      lonSpan.style.color = "";
    }, 1000);
  }
  latSpan.addEventListener("click", handleCoordClick);
  lonSpan.addEventListener("click", handleCoordClick);
}

/*
 * Hjælper: opret/opdater "aktuel markør"
 * Respekterer keepMarkersEnabled / keepMarkersLayer
 */
function createSelectionMarker(lat, lon) {
  if (!keepMarkersEnabled) {
    // Normal tilstand: kun én markør – fjern den gamle
    if (currentMarker && map.hasLayer(currentMarker)) {
      map.removeLayer(currentMarker);
    }
    currentMarker = L.marker([lat, lon]).addTo(map);
  } else {
    // Multi-markør-tilstand: behold alle markører i keepMarkersLayer
    const m = L.marker([lat, lon]);
    keepMarkersLayer.addLayer(m);
    currentMarker = m;
  }
  return currentMarker;
}

/*
 * Strandposter – global cache
 */
var allStrandposter = [];
var strandposterReady = false;
function fetchAllStrandposter() {
  const localUrl = "Strandposter";
  console.log("Henter alle strandposter fra lokal fil:", localUrl);
  return fetch(localUrl)
    .then(resp => resp.json())
    .then(geojson => {
      if (geojson.features) {
        allStrandposter = geojson.features;
        strandposterReady = true;
        console.log("Alle strandposter hentet fra lokal fil:", allStrandposter);
        setLastUpdated();
      } else {
        console.warn("Ingen strandposter modtaget fra lokal fil.");
      }
    })
    .catch(err => {
      console.error("Fejl ved hentning af lokal strandposter-fil:", err);
    });
}
map.on("overlayadd", function(event) {
  if (event.name === "Strandposter") {
    console.log("Strandposter laget er tilføjet.");
    if (allStrandposter.length === 0) {
      console.log("Henter strandposter-data første gang...");
      fetchAllStrandposter();
    } else {
      console.log("Strandposter-data allerede hentet.");
    }
  }
});

/*
 * Klik på kort => reverse geocoding
 */
map.on('click', function(e) {
  let lat = e.latlng.lat;
  let lon = e.latlng.lng;

  // Brug fælles helper, så den respekterer "Behold markører"
  createSelectionMarker(lat, lon);

  setCoordinateBox(lat, lon);

  if (isInDenmarkByPolygon(lat, lon)) {
    // DK: Dataforsyningen
    let revUrl = `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${lon}&y=${lat}&struktur=flad`;
    fetch(revUrl)
      .then(r => r.json())
      .then(data => {
        updateInfoBox(data, lat, lon);
        fillRouteFieldsFromClick(data, lat, lon);
      })
      .catch(err => console.error("Reverse geocoding fejl:", err));
  } else {
    // Udland: ORS reverse geocoding
    reverseGeocodeORS(lat, lon)
      .then(feature => {
        if (!feature) return;

        updateInfoBoxForeign(feature, lat, lon);

        const p = feature.properties || {};
        const norm = {
          vejnavn: p.street || p.name || "",
          husnr: p.housenumber || "",
          postnr: p.postalcode || "",
          postnrnavn: p.locality || p.region || p.country || ""
        };
        fillRouteFieldsFromClick(norm, lat, lon);
      })
      .catch(err => console.error("ORS reverse geocoding fejl:", err));
  }
});

/*
 * updateInfoBox for danske adresser
 *  - data: objekt fra Dataforsyningen (adgangsadresse eller adresse)
 *  - lat/lon: koordinater i WGS84
 *  - enhedsLabel (valgfri): fuld enhedsadresse inkl. etage/dør til visning
 */
async function updateInfoBox(data, lat, lon, enhedsLabel) {
  const streetviewLink = document.getElementById("streetviewLink");
  const addressEl      = document.getElementById("address");
  const extraInfoEl    = document.getElementById("extra-info");
  const skråfotoLink   = document.getElementById("skraafotoLink");
  const overlay        = document.getElementById("kommuneOverlay");

  let adresseStr, vejkode, kommunekode;
  let evaFormat, notesFormat;

  // Byg grund-adresse (uden etage/dør) ud fra data
  if (data.adgangsadresse) {
    // Typisk når data kommer fra /adresser eller /adgangsadresser
    adresseStr = data.adgangsadresse.adressebetegnelse ||
      `${data.adgangsadresse.vejnavn || ""} ${data.adgangsadresse.husnr || ""}, ${data.adgangsadresse.postnr || ""} ${data.adgangsadresse.postnrnavn || ""}`;
    evaFormat   = `${data.adgangsadresse.vejnavn || ""},${data.adgangsadresse.husnr || ""},${data.adgangsadresse.postnr || ""}`;
    notesFormat = `${data.adgangsadresse.vejnavn || ""} ${data.adgangsadresse.husnr || ""}, ${data.adgangsadresse.postnr || ""} ${data.adgangsadresse.postnrnavn || ""}`;
    vejkode     = data.adgangsadresse.vejkode || "?";
    kommunekode = data.adgangsadresse.kommunekode || "?";
  } else if (data.adressebetegnelse) {
    // Flad struktur fra fx reverse-kald
    adresseStr  = data.adressebetegnelse;
    evaFormat   = "?, ?, ?";
    notesFormat = "?, ?, ?";
    vejkode     = data.vejkode     || "?";
    kommunekode = data.kommunekode || "?";
  } else {
    // Fallback hvis strukturen er mere simpel
    adresseStr  = `${data.vejnavn || "?"} ${data.husnr || ""}, ${data.postnr || "?"} ${data.postnrnavn || ""}`;
    evaFormat   = `${data.vejnavn || ""},${data.husnr || ""},${data.postnr || ""}`;
    notesFormat = `${data.vejnavn || ""} ${data.husnr || ""}, ${data.postnr || ""} ${data.postnrnavn || ""}`;
    vejkode     = data.vejkode     || "?";
    kommunekode = data.kommunekode || "?";
  }

  // Hvis vi har en enheds-adresse (med etage/dør), så brug den som visningstekst
  const displayAddress =
    (typeof enhedsLabel === "string" && enhedsLabel.trim().length > 0)
      ? enhedsLabel
      : adresseStr;

  // Street View-link og adressefelt
  streetviewLink.href   = `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lon}`;
  addressEl.textContent = displayAddress;

  // Eva.Net-link
  extraInfoEl.innerHTML = "";
  extraInfoEl.insertAdjacentHTML(
    "beforeend",
    `
    <a href="#" title="Kopier til Eva.net" onclick="(function(el){ el.style.color='red'; copyToClipboard('${evaFormat}'); showCopyPopup('Kopieret'); setTimeout(function(){ el.style.color=''; },1000); })(this); return false;">Eva.Net</a>
    `
  );

  // Skråfoto-link + popup
  skråfotoLink.href = `https://skraafoto.dataforsyningen.dk/?search=${encodeURIComponent(adresseStr)}`;
  skråfotoLink.style.display = "inline";
  skråfotoLink.onclick = function(e) {
    e.preventDefault();
    copyToClipboard(adresseStr);
    let msg = document.createElement("div");
    msg.textContent = "Adressen er kopieret til udklipsholder.";
    msg.style.position = "fixed";
    msg.style.top = "20px";
    msg.style.left = "50%";
    msg.style.transform = "translateX(-50%)";
    msg.style.background = "rgba(0,0,0,0.7)";
    msg.style.color = "white";
    msg.style.padding = "10px 15px";
    msg.style.borderRadius = "5px";
    msg.style.zIndex = "1000";
    document.body.appendChild(msg);
    setTimeout(function() {
      document.body.removeChild(msg);
      window.open(skråfotoLink.href, '_blank');
    }, 1000);
  };

  // Overlay med kommune- og vejkode
  overlay.textContent = `Kommunekode: ${kommunekode} | Vejkode: ${vejkode}`;
  overlay.style.display = "block";

  // Ryd søgeresultater
  if (resultsList) resultsList.innerHTML = "";
  if (vej1List)    vej1List.innerHTML    = "";
  if (vej2List)    vej2List.innerHTML    = "";

  // ----- Statsvej-data -----
  const statsvejInfoEl = document.getElementById("statsvejInfo");
  let statsvejData = await checkForStatsvej(lat, lon);

  const admNr       = statsvejData?.ADM_NR       ?? statsvejData?.adm_nr       ?? null;
  const forgrening  = statsvejData?.FORGRENING   ?? statsvejData?.forgrening   ?? null;
  const betegnelse  = statsvejData?.BETEGNELSE   ?? statsvejData?.betegnelse   ?? null;
  const bestyrer    = statsvejData?.BESTYRER     ?? statsvejData?.bestyrer     ?? null;
  const vejtype     = statsvejData?.VEJTYPE      ?? statsvejData?.vejtype      ?? null;
  const beskrivelse = statsvejData?.BESKRIVELSE  ?? statsvejData?.beskrivelse  ?? null;
  const vejstatus   = statsvejData?.VEJSTATUS    ?? statsvejData?.vejstatus    ?? statsvejData?.VEJ_STATUS ?? statsvejData?.status ?? null;
  const vejmynd     = statsvejData?.VEJMYNDIGHED ?? statsvejData?.vejmyndighed ?? statsvejData?.VEJMYND     ?? statsvejData?.vejmynd ?? null;

  const hasStatsvej = admNr != null || forgrening != null ||
    (betegnelse && String(betegnelse).trim() !== "") ||
    (vejtype && String(vejtype).trim() !== "");
  const showStatsBox = hasStatsvej || vejstatus || vejmynd;

  if (showStatsBox) {
    let html = "";
    if (hasStatsvej) {
      html += `<strong>Administrativt nummer:</strong> ${admNr || "Ukendt"}<br>`;
      html += `<strong>Forgrening:</strong> ${forgrening || "Ukendt"}<br>`;
      html += `<strong>Vejnavn:</strong> ${betegnelse || "Ukendt"}<br>`;
      html += `<strong>Bestyrer:</strong> ${bestyrer || "Ukendt"}<br>`;
      html += `<strong>Vejtype:</strong> ${vejtype || "Ukendt"}`;
    }
    if (vejstatus) {
      html += `<br><strong>Vejstatus:</strong> ${vejstatus}`;
    }
    if (vejmynd) {
      html += `<br><strong>Vejmyndighed:</strong> ${vejmynd}`;
    }
    statsvejInfoEl.innerHTML = html;

    if (hasStatsvej) {
      const kmText = await getKmAtPoint(lat, lon);
      if (kmText) {
        statsvejInfoEl.innerHTML += `<br><strong>Km:</strong> ${kmText}`;
      }
    }
    document.getElementById("statsvejInfoBox").style.display = "block";
  } else {
    statsvejInfoEl.innerHTML = "";
    document.getElementById("statsvejInfoBox").style.display = "none";
  }

  // Vis infoboksen
  document.getElementById("infoBox").style.display = "block";

  // ----- Kommuneinfo (fra kommuneInfo) -----
  if (kommunekode !== "?") {
    try {
      const komUrl = `https://api.dataforsyningen.dk/kommuner/${kommunekode}`;
      const komResp = await fetch(komUrl);
      if (komResp.ok) {
        const komData = await komResp.json();
        const kommunenavn = komData.navn || "";
        if (kommunenavn && kommuneInfo[kommunenavn]) {
          const info = kommuneInfo[kommunenavn];
          const link = info.gemLink;
          if (link) {
            extraInfoEl.innerHTML += `<br><span style="font-size:16px;">Kommune: <a href="${link}" target="_blank">${kommunenavn}</a></span>`;
          } else {
            extraInfoEl.innerHTML += `<br><span style="font-size:16px;">Kommune: ${kommunenavn}</span>`;
          }
        }
      }
    } catch (e) {
      console.error("Kunne ikke hente kommuneinfo:", e);
    }
  }

  // ----- Politikreds-info (hvis tilgængelig) -----
  const politikredsNavn = data.politikredsnavn
    ?? data.adgangsadresse?.politikredsnavn
    ?? null;
  const politikredsKode = data.politikredskode
    ?? data.adgangsadresse?.politikredskode
    ?? null;
  if (politikredsNavn || politikredsKode) {
    const polititekst = politikredsKode
      ? `${politikredsNavn || ""} (${politikredsKode})`
      : `${politikredsNavn}`;
    extraInfoEl.innerHTML += `<br><span style="font-size:16px;">Politikreds: ${polititekst}</span>`;
  }

    // ----- BBR-data (bygninger) – bruger husnummerId og evt. BFE-nummer -----
  try {
    let bbrId = null;

    if (data && (data.husnummerId || data.husnummerid)) {
      bbrId = data.husnummerId || data.husnummerid;
    } else if (data && (data.adgangsadresseid || data.adgangsadresseId)) {
      bbrId = data.adgangsadresseid || data.adgangsadresseId;
    } else if (data && data.adgangsadresse &&
      (data.adgangsadresse.husnummerId || data.adgangsadresse.husnummerid)) {
      bbrId = data.adgangsadresse.husnummerId || data.adgangsadresse.husnummerid;
    } else if (data && data.adgangsadresse && data.adgangsadresse.id) {
      bbrId = data.adgangsadresse.id;
    } else if (data && data.id) {
      bbrId = data.id;
    }

    // NYT: forsøg også at finde et BFE-nummer i adresse-objektet
    const bfeNumber = extractBfeNumberFromAdresse(data);

    if (bbrId || bfeNumber) {
      // Videresend til BBR-visningsfunktionen med både husnummer-id og BFE
      renderBBRInfo(bbrId, lat, lon, bfeNumber);
    } else {
      const bbrBox = document.getElementById("bbrInfoBox");
      if (bbrBox) {
        bbrBox.innerHTML = "<p>Ingen BBR-id tilgængelig for denne adresse.</p>";
        bbrBox.classList.remove("hidden");
        bbrBox.style.display = "block";
      }
    }
  } catch (err) {
    console.warn("BBR-data kunne ikke hentes:", err);
  }
}
/*
 * updateInfoBoxForeign – ORS-adresser i udlandet
 */
function updateInfoBoxForeign(feature, lat, lon) {
  const streetviewLink = document.getElementById("streetviewLink");
  const addressEl      = document.getElementById("address");
  const extraInfoEl    = document.getElementById("extra-info");
  const skråfotoLink   = document.getElementById("skraafotoLink");
  const overlay        = document.getElementById("kommuneOverlay");
  const statsvejInfoEl = document.getElementById("statsvejInfo");
  const statsvejBox    = document.getElementById("statsvejInfoBox");

  const p = feature.properties || {};
  const vejnavn = p.street || p.name || "";
  const husnr   = p.housenumber || "";
  const postnr  = p.postalcode || "";
  const by      = p.locality || p.region || p.country || "";

  const label =
    p.label ||
    `${vejnavn} ${husnr}, ${postnr} ${by}`.replace(/\s+/g, " ").trim();

  const evaFormat   = `${vejnavn},${husnr},${postnr}`;
  const notesFormat = `${vejnavn} ${husnr}, ${postnr} ${by}`;

  streetviewLink.href   = `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lon}`;
  addressEl.textContent = label;

  extraInfoEl.innerHTML = `
    <a href="#" title="Kopier til Eva.net" onclick="(function(el){ el.style.color='red'; copyToClipboard('${evaFormat}'); showCopyPopup('Kopieret'); setTimeout(function(){ el.style.color=''; },1000); })(this); return false;">Eva.Net</a>
  `;

  // Ingen skråfoto / kommune / statsvej i udlandet
  skråfotoLink.style.display = "none";
  overlay.style.display       = "none";
  statsvejInfoEl.innerHTML    = "";
  statsvejBox.style.display   = "none";
  // Skjul BBR-boksen for udenlandske adresser
  hideBBRInfo();

  document.getElementById("infoBox").style.display = "block";

  if (resultsList) resultsList.innerHTML = "";
  if (vej1List)    vej1List.innerHTML    = "";
  if (vej2List)    vej2List.innerHTML    = "";
}

/**
 * Hent BBR-data for en adgangsadresse (bygninger) ved hjælp af bbrlight API.
 * Returnerer en liste af bygninger eller null ved fejl.
 */
/*
 * Forsøg at finde et BFE-nummer i adresse-objektet
 * (både direkte på data og på data.adgangsadresse).
 */
function extractBfeNumberFromAdresse(data) {
  if (!data || typeof data !== "object") return null;

  function search(obj) {
    if (!obj || typeof obj !== "object") return null;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      // Fang fx "bfenummer", "BfeNummer" etc.
      if (/bfe.*nummer/i.test(key)) {
        const val = obj[key];
        if (val === null || val === undefined) return null;
        if (typeof val === "object" && "kode" in val) {
          return val.kode;
        }
        return val;
      }
    }
    return null;
  }

  const direct = search(data);
  if (direct != null) return direct;

  if (data.adgangsadresse) {
    const nested = search(data.adgangsadresse);
    if (nested != null) return nested;
  }

  return null;
}

/**
 * Hent BBR-data for en adgangsadresse (bygninger) via Cloudflare BBR-proxyen.
 * Returnerer en liste af bygninger eller null ved fejl.
 */
/**
 * Hent BBR-data for en adresse (bygninger) via Cloudflare BBR-proxyen.
 * Vi prøver først med BFE-nummer (hvis tilgængeligt) og falder derefter
 * tilbage til husnummer-id (DAR husnummer/adgangsadresse).
 */
async function fetchBBRData(bbrId, bfeNumber) {
  try {
    if (!bbrId && !bfeNumber) {
      console.warn("fetchBBRData kaldt uden husnummerId eller BFE-nummer");
      return [];
    }

    const urls = [];

    // 1) Prøv BFE-nummer først, hvis vi har et
    if (bfeNumber) {
      urls.push(`${BBR_PROXY}/bygning?bfenummer=${encodeURIComponent(bfeNumber)}`);
    }

    // 2) Fald tilbage til husnummer-id
    if (bbrId) {
      urls.push(`${BBR_PROXY}/bygning?husnummer=${encodeURIComponent(bbrId)}`);
    }

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          console.warn("BBR 2.1 proxy-fejl for URL", url, resp.status);
          continue;
        }

        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
          return data;
        }
      } catch (innerErr) {
        console.warn("BBR fetch-fejl for URL", url, innerErr);
      }
    }

    // Hvis ingen af opslagene gav noget, returner tom liste
    return [];
  } catch (e) {
    console.error("BBR fetch error via proxy:", e);
    return [];
  }
}

// Hjælpefunktion: find første felt i et objekt (og evt. underobjekter), hvor nøglen matcher et regex.
function findFirstMatchingField(obj, regex) {
  if (!obj || typeof obj !== "object") return null;

  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;

    const value = obj[key];

    if (regex.test(key)) {
      if (value && typeof value === "object") {
        if (Object.prototype.hasOwnProperty.call(value, "tekst")) {
          return value.tekst;
        }
        if (Object.prototype.hasOwnProperty.call(value, "navn")) {
          return value.navn;
        }
        if (Object.prototype.hasOwnProperty.call(value, "kode")) {
          return value.kode;
        }
      }
      return value;
    }

    if (value && typeof value === "object") {
      const nested = findFirstMatchingField(value, regex);
      if (nested != null) {
        return nested;
      }
    }
  }

  return null;
}

// Hjælpefunktion: saml alle relevante BFE-numre fra BBR-bygninger + evt. et direkte bfeNumber.
function collectBfeNumbersFromBuildings(buildings, fallbackBfeNumber) {
  const result = new Set();

  if (fallbackBfeNumber != null && fallbackBfeNumber !== "") {
    result.add(String(fallbackBfeNumber));
  }

  if (Array.isArray(buildings)) {
    buildings.forEach(b => {
      const building = (b && b.bygning) ? b.bygning : b;
      if (!building || typeof building !== "object") return;

      const bfeVal = findFirstMatchingField(building, /bfe.*nummer/i);
      if (bfeVal != null && bfeVal !== "") {
        result.add(String(bfeVal));
      }
    });
  }

  return Array.from(result);
}

// Hjælpefunktion: hent Ejendomsbeliggenhed-data for et eller flere BFE-numre via proxien.
async function fetchEjendomsbeliggenhedForBFE(bfeNumbers) {
  try {
    const list = Array.isArray(bfeNumbers) ? bfeNumbers : [bfeNumbers];
    const cleaned = list
      .map(v => (v != null ? String(v).trim() : ""))
      .filter(v => v !== "");

    if (cleaned.length === 0) {
      return [];
    }

    const bfeParam = cleaned.join("|");
    const url = `${BBR_PROXY}/Ejendomsbeliggenhed2?bfenr=${encodeURIComponent(bfeParam)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn("Ejendomsbeliggenhed proxy-fejl:", resp.status, resp.statusText);
      return [];
    }

    const data = await resp.json();

    if (Array.isArray(data)) {
      return data;
    }

    if (data && Array.isArray(data.results)) {
      return data.results;
    }

    if (data && data.ejendomsbeliggenhed) {
      return Array.isArray(data.ejendomsbeliggenhed)
        ? data.ejendomsbeliggenhed
        : [data.ejendomsbeliggenhed];
    }

    return [data];
  } catch (err) {
    console.error("Fejl i fetchEjendomsbeliggenhedForBFE:", err);
    return [];
  }
}

// Opslagstabeller til BBR-koder (kilde: bbr.dk/kodelister)
const BBR_TAGDAEKNING = {
  1: "Tagpap med lille hældning",
  2: "Tagpap med stor hældning",
  3: "Fibercement herunder asbest",
  4: "Betontagsten",
  5: "Tegl",
  6: "Metal",
  7: "Stråtag",
  10: "Fibercement uden asbest",
  11: "Plastmaterialer",
  12: "Glas",
  20: "Levende tage",
  90: "Andet materiale"
};

const BBR_YDERVAEG = {
  1: "Mursten",
  2: "Letbetonsten",
  3: "Fibercement herunder asbest",
  4: "Bindingsværk",
  5: "Træ",
  6: "Betonelementer",
  8: "Metal",
  10: "Fibercement uden asbest",
  11: "Plastmaterialer",
  12: "Glas",
  80: "Ingen",
  90: "Andet materiale"
};

const BBR_VARMEINSTALLATION = {
  1: "Fjernvarme/blokvarme",
  2: "Centralvarme med én fyringsenhed",
  3: "Ovn til fast og flydende brændsel",
  5: "Varmepumpe",
  6: "Centralvarme med to fyringsenheder",
  7: "Elvarme",
  8: "Gasradiator",
  9: "Ingen varmeinstallation",
  99: "Blandet"
};

const BBR_OPVARMNINGSMIDDEL = {
  1: "Elektricitet",
  2: "Gasværksgas",
  3: "Flydende brændsel",
  4: "Fast brændsel",
  6: "Halm",
  7: "Naturgas",
  9: "Andet"
};

const BBR_SUPPLERENDE_VARME = {
  0: "Ikke oplyst",
  1: "Varmepumpe",
  2: "Brændeovne og lignende med skorsten",
  3: "Biopejse og lignende uden skorsten",
  4: "Solpaneler",
  5: "Pejs",
  6: "Gasradiator",
  7: "Elvarme",
  10: "Biogasanlæg",
  80: "Andet",
  90: "(Udfases) Ingen supplerende varme"
};

const BBR_BYGNINGSANVENDELSE = {
  110: "Stuehus til landbrugsejendom",
  120: "Fritliggende enfamiliehus",
  121: "Sammenbygget enfamiliehus",
  122: "Fritliggende enfamiliehus i tæt-lav bebyggelse",
  130: "(Udfases) Række-, kæde- eller dobbelthus",
  131: "Række-, kæde- og klyngehus",
  132: "Dobbelthus",
  140: "Etagebolig, flerfamilie- eller to-familiehus",
  150: "Kollegium",
  160: "Boligbygning til døgninstitution",
  185: "Anneks til helårsbolig",
  190: "Anden bygning til helårsbeboelse",
  211: "Stald til svin",
  212: "Stald til kvæg, får mv.",
  213: "Stald til fjerkræ",
  214: "Minkhal",
  215: "Væksthus",
  216: "Lade til foder, afgrøder mv.",
  217: "Maskinhus, garage mv.",
  218: "Lade til halm, hø mv.",
  219: "Anden bygning til landbrug mv.",
  221: "Bygning til industri med integreret produktionsapparat",
  222: "Bygning til industri uden integreret produktionsapparat",
  223: "Værksted",
  229: "Anden bygning til produktion",
  231: "Bygning til energiproduktion",
  232: "Bygning til energidistribution",
  233: "Bygning til vandforsyning",
  234: "Bygning til håndtering af affald og spildevand",
  239: "Anden bygning til energiproduktion og forsyning",
  311: "Bygning til jernbane- og busdrift",
  312: "Bygning til luftfart",
  313: "Bygning til parkering- og transportanlæg",
  314: "Bygning til parkering ved boliger",
  315: "Havneanlæg",
  319: "Andet transportanlæg",
  321: "Bygning til kontor",
  322: "Bygning til detailhandel",
  323: "Bygning til lager",
  324: "Butikscenter",
  325: "Tankstation",
  329: "Anden bygning til kontor, handel og lager",
  331: "Hotel, kro eller konferencecenter med overnatning",
  332: "Bed & breakfast mv.",
  333: "Restaurant, café mv. uden overnatning",
  334: "Privat servicevirksomhed",
  339: "Anden bygning til serviceerhverv",
  411: "Biograf, teater, koncertsted mv.",
  412: "Museum",
  413: "Bibliotek",
  414: "Kirke eller anden bygning til trosudøvelse",
  415: "Forsamlingshus",
  416: "Forlystelsespark",
  419: "Anden bygning til kulturelle formål",
  421: "Grundskole",
  422: "Universitet",
  429: "Anden bygning til undervisning og forskning",
  431: "Hospital og sygehus",
  432: "Hospice, behandlingshjem mv.",
  433: "Sundhedscenter, lægehus mv.",
  439: "Anden bygning til sundhedsformål",
  441: "Daginstitution",
  442: "Servicefunktion på døgninstitution",
  443: "Kaserne",
  444: "Fængsel, arresthus mv.",
  449: "Anden bygning til institutionsformål",
  451: "Beskyttelsesrum",
  510: "Sommerhus",
  521: "Feriecenter eller campingplads",
  522: "Bygning med ferielejligheder til udlejning",
  523: "Bygning med ferielejligheder til eget brug",
  529: "Anden bygning til ferieformål",
  531: "Klubhus i forbindelse med idræt",
  532: "Svømmehal",
  533: "Idrætshal",
  534: "Tribune ved stadion",
  535: "Bygning til træning og opstaldning af heste",
  539: "Anden bygning til idrætformål",
  540: "Kolonihavehus",
  585: "Anneks til fritids- eller sommerhus",
  590: "Anden bygning til fritidsformål",
  910: "Garage",
  920: "Carport",
  930: "Udhus",
  940: "Drivhus",
  950: "Fritliggende overdækning",
  960: "Fritliggende udestue",
  970: "Tiloversbleven landbrugsbygning",
  990: "Faldefærdig bygning",
  999: "Ukendt bygning"
};

// Hjælpere til at læse og beskrive BBR-koder
function getBBRCode(obj, primaryKey, fallbackRegex) {
  if (!obj) return null;

  if (primaryKey && Object.prototype.hasOwnProperty.call(obj, primaryKey)) {
    const value = obj[primaryKey];
    if (value && typeof value === "object" && "kode" in value) {
      return value.kode;
    }
    return value;
  }

  if (fallbackRegex) {
    const regex = fallbackRegex;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      if (regex.test(key)) {
        const value = obj[key];
        if (value && typeof value === "object" && "kode" in value) {
          return value.kode;
        }
        return value;
      }
    }
  }

  return null;
}

function getBBRValue(obj, primaryKey, fallbackRegex) {
  if (!obj) return null;

  if (primaryKey && Object.prototype.hasOwnProperty.call(obj, primaryKey)) {
    return obj[primaryKey];
  }

  if (fallbackRegex) {
    const regex = fallbackRegex;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      if (regex.test(key)) {
        return obj[key];
      }
    }
  }

  return null;
}

function describeBBRCode(dict, code) {
  if (code === null || code === undefined || code === "") return null;
  const key = String(code);
  const label = dict[key];
  if (label) {
    return `${label} (kode ${key})`;
  }
  return `Kode ${key}`;
}
/*
 * Hjælper: skjul BBR-boksen og ryd BBR-markører
 */
function hideBBRInfo() {
  const bbrBox = document.getElementById("bbrInfoBox");
  if (bbrBox) {
    bbrBox.innerHTML = "";
    bbrBox.classList.add("hidden");
    bbrBox.style.display = "none";
  }

  if (bbrBuildingsLayer) {
    bbrBuildingsLayer.clearLayers();
    if (map.hasLayer(bbrBuildingsLayer)) {
      map.removeLayer(bbrBuildingsLayer);
    }
  }
}

/**
 * Render BBR-info i infoboksen. Viser et antal bygninger og detaljer i <details>-elementer.
 * Hvis ingen data findes, vises en besked.
 */
function renderBBRInfo(bbrId, fallbackLat, fallbackLon, bfeNumber) {
  const bbrBox = document.getElementById("bbrInfoBox");
  if (!bbrBox) return;

  // Ryd eksisterende BBR-bygning-markører
  if (bbrBuildingsLayer) {
    bbrBuildingsLayer.clearLayers();
    if (map.hasLayer(bbrBuildingsLayer)) {
      map.removeLayer(bbrBuildingsLayer);
    }
  }

  // Vis loading og gør boksen synlig
  bbrBox.innerHTML = "Henter BBR-data...";
  bbrBox.classList.remove("hidden");
  bbrBox.style.display = "block";

  fetchBBRData(bbrId, bfeNumber)
    .then(async data => {
      // Ingen data
      if (!data || data.length === 0) {
        bbrBox.innerHTML = `
  <div class="bbr-header" style="position: relative;">
    <span class="bbr-title">BBR – bygninger på adressen</span>
    <span id="bbrCloseBtn" class="close">&times;</span>
  </div>
  <p>Ingen BBR-data fundet.</p>
`;
        const closeEl = document.getElementById("bbrCloseBtn");
        if (closeEl) {
          closeEl.onclick = hideBBRInfo;
        }
        return;
      }

      // Header med titel + luk-knap
      let html = `
  <div class="bbr-header" style="position: relative;">
    <span class="bbr-title">BBR – bygninger på adressen</span>
    <span id="bbrCloseBtn" class="close">&times;</span>
  </div>
  <div class="bbr-content">
`;

      data.forEach((b, idx) => {
        // Hvis proxien på et tidspunkt returnerer { bygning: {...} }, så brug bygning-delen.
        const building = (b && b.bygning) ? b.bygning : b;

        // Basisfelter (forsøg først med de konkrete BBR 2.1-felter, derefter generisk fallback)
        const bygningsnr = building["byg007Bygningsnummer"] ?? getBBRValue(building, "bygningsnr", /bygningsnr|bygningsnummer/i);
        const anvKode = building["byg021BygningensAnvendelse"] ?? getBBRCode(building, "bygningsanvendelse", /anvendelse/i);
        const anvTekst = anvKode != null ? describeBBRCode(BBR_BYGNINGSANVENDELSE, anvKode) : null;
        const opfoerAar = building["byg026Opførelsesår"] ?? getBBRValue(building, "opfoerelsesaar", /opfoerelsesaar/i);
        const tagKode = building["byg033Tagdækningsmateriale"] ?? getBBRCode(building, "tagdaekningsmateriale", /tagd[æae]kningsmateriale/i);
        const tagTekst = tagKode != null ? describeBBRCode(BBR_TAGDAEKNING, tagKode) : null;
        const ydervKode = building["byg032YdervæggensMateriale"] ?? getBBRCode(building, "ydervaegsmateriale", /yderv[æae]gsmateriale/i);
        const ydervTekst = ydervKode != null ? describeBBRCode(BBR_YDERVAEG, ydervKode) : null;
        const varmeKode = building["byg056Varmeinstallation"] ?? getBBRCode(building, "varmeinstallation", /varmeinstallation/i);
        const varmeTekst = varmeKode != null ? describeBBRCode(BBR_VARMEINSTALLATION, varmeKode) : null;
        const opvKode = building["byg057Opvarmningsmiddel"] ?? getBBRCode(building, "opvarmningsmiddel", /opvarmningsmiddel/i);
        const opvTekst = opvKode != null ? describeBBRCode(BBR_OPVARMNINGSMIDDEL, opvKode) : null;
        const supVarmeKode = building["byg058SupplerendeVarme"] ?? getBBRCode(building, "supplerendeVarme", /supplerende.*varme/i);
        const supVarmeTekst = supVarmeKode != null ? describeBBRCode(BBR_SUPPLERENDE_VARME, supVarmeKode) : null;

        // Etager og arealer
        const antalEtager = building["byg054AntalEtager"] ?? getBBRValue(building, "antalEtager", /antal.*etager/i);
        const samletAreal = building["byg038SamletBygningsareal"] ?? getBBRValue(building, "samletBygningsareal", /samlet.*bygningsareal/i);
        const boligAreal = building["byg039BygningensSamledeBoligAreal"] ?? getBBRValue(building, "boligareal", /samlede.*bolig.*areal/i);
        const bebyggetAreal = building["byg041BebyggetAreal"] ?? getBBRValue(building, "bebyggedeAreal", /bebygget.*areal/i);

        // Datoer / opdatering
        const opdateringDatoStr = building["datafordelerOpdateringstid"] || null;
        const revisionsDatoStr = building["byg094Revisionsdato"] || null;
        const opdateringDato = opdateringDatoStr ? String(opdateringDatoStr).split("T")[0] : null;
        const revisionsDato = revisionsDatoStr ? String(revisionsDatoStr).split("T")[0] : null;

        // Overskrift for den enkelte bygning
        const summaryTitleParts = [];
        summaryTitleParts.push(`Bygning ${idx + 1}`);
        if (anvTekst) {
          summaryTitleParts.push(anvTekst);
        } else if (anvKode != null) {
          summaryTitleParts.push(`Anvendelse kode ${anvKode}`);
        }
        if (opfoerAar) {
          summaryTitleParts.push(`opf. ${opfoerAar}`);
        }
        const summaryTitle = summaryTitleParts.join(" – ");

        // Detaljeret liste
        let detailsHtml = "<ul>";
        if (bygningsnr != null) {
          detailsHtml += `<li><strong>Bygningsnr:</strong> ${bygningsnr}</li>`;
        }
        if (anvTekst) {
          detailsHtml += `<li><strong>Anvendelse:</strong> ${anvTekst}</li>`;
        } else if (anvKode != null) {
          detailsHtml += `<li><strong>Anvendelse:</strong> Kode ${anvKode}</li>`;
        }
        if (opfoerAar != null) {
          detailsHtml += `<li><strong>Opførelsesår:</strong> ${opfoerAar}</li>`;
        }
        if (antalEtager != null) {
          detailsHtml += `<li><strong>Antal etager:</strong> ${antalEtager}</li>`;
        }
        if (samletAreal != null) {
          detailsHtml += `<li><strong>Samlet bygningsareal:</strong> ${samletAreal} m²</li>`;
        }
        if (boligAreal != null) {
          detailsHtml += `<li><strong>Samlet boligareal:</strong> ${boligAreal} m²</li>`;
        }
        if (bebyggetAreal != null) {
          detailsHtml += `<li><strong>Bebygget areal:</strong> ${bebyggetAreal} m²</li>`;
        }
        if (tagTekst) {
          detailsHtml += `<li><strong>Tagdækningsmateriale:</strong> ${tagTekst}</li>`;
        } else if (tagKode != null) {
          detailsHtml += `<li><strong>Tagdækningsmateriale:</strong> Kode ${tagKode}</li>`;
        }
        if (ydervTekst) {
          detailsHtml += `<li><strong>Ydervægsmateriale:</strong> ${ydervTekst}</li>`;
        } else if (ydervKode != null) {
          detailsHtml += `<li><strong>Ydervægsmateriale:</strong> Kode ${ydervKode}</li>`;
        }
        if (varmeTekst) {
          detailsHtml += `<li><strong>Varmeinstallation:</strong> ${varmeTekst}</li>`;
        } else if (varmeKode != null) {
          detailsHtml += `<li><strong>Varmeinstallation:</strong> Kode ${varmeKode}</li>`;
        }
        if (opvTekst) {
          detailsHtml += `<li><strong>Opvarmningsmiddel:</strong> ${opvTekst}</li>`;
        } else if (opvKode != null) {
          detailsHtml += `<li><strong>Opvarmningsmiddel:</strong> Kode ${opvKode}</li>`;
        }
        if (supVarmeTekst) {
          detailsHtml += `<li><strong>Supplerende varme:</strong> ${supVarmeTekst}</li>`;
        } else if (supVarmeKode != null) {
          detailsHtml += `<li><strong>Supplerende varme:</strong> Kode ${supVarmeKode}</li>`;
        }
        if (opdateringDato) {
          detailsHtml += `<li><strong>Data opdateret:</strong> ${opdateringDato}</li>`;
        }
        if (revisionsDato) {
          detailsHtml += `<li><strong>BBR-revisionsdato:</strong> ${revisionsDato}</li>`;
        }
        detailsHtml += "</ul>";

        html += `<details>
  <summary>${summaryTitle}</summary>
  ${detailsHtml}
  <details>
      <summary>Vis rå BBR-data</summary>
      <pre>${JSON.stringify(building, null, 2)}</pre>
  </details>
</details>`;

        // --- marker på kortet for bygningen (bygningsnummer som label) ---
        let bLat = null;
        let bLon = null;

        if (building.geometri && Array.isArray(building.geometri.koordinater)) {
          const c = building.geometri.koordinater;
          if (c.length >= 2) {
            bLon = c[0];
            bLat = c[1];
          }
        } else if (Array.isArray(building.koordinater) && building.koordinater.length >= 2) {
          const c = building.koordinater;
          bLon = c[0];
          bLat = c[1];
        }

        if (bLat === null || bLon === null) {
          if (typeof fallbackLat === "number" && typeof fallbackLon === "number") {
            bLat = fallbackLat;
            bLon = fallbackLon;
          }
        }

        if (bLat != null && bLon != null) {
          if (Math.abs(bLat) > 90 || Math.abs(bLon) > 90) {
            const converted = convertToWGS84(bLon, bLat);
            bLat = converted[0];
            bLon = converted[1];
          }

          const labelText = bygningsnr != null ? String(bygningsnr) : String(idx + 1);

          const iconHtml = `<div class="bbr-building-icon">${labelText}</div>`;
          const buildingIcon = L.divIcon({
            html: iconHtml,
            className: "bbr-building-icon-wrapper",
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          });

          const m = L.marker([bLat, bLon], { icon: buildingIcon });
          m.addTo(bbrBuildingsLayer);
        }
      });

      // --- Ejendomsbeliggenhed (Ejendomsdata pr. BFE) ---
      try {
        const bfeList = collectBfeNumbersFromBuildings(data, bfeNumber);
        if (bfeList && bfeList.length > 0) {
          const ejendomsListe = await fetchEjendomsbeliggenhedForBFE(bfeList);
          if (ejendomsListe && ejendomsListe.length > 0) {
            html += `<details open>
  <summary>Ejendomsoplysninger (Ejendomsbeliggenhed)</summary>
`;
            ejendomsListe.forEach((ejd, idx2) => {
              const bfeVal = findFirstMatchingField(ejd, /bfe.*nummer/i);
              const matrikel = findFirstMatchingField(ejd, /matrikel.*betegnelse/i) || findFirstMatchingField(ejd, /matrikel/i);
              const ejerlav = findFirstMatchingField(ejd, /ejerlav.*navn/i) || findFirstMatchingField(ejd, /ejerlav/i);
              const komNavn = findFirstMatchingField(ejd, /kommu.*navn/i);
              const komKode = findFirstMatchingField(ejd, /kommu.*kode/i);
              const vejnavnEjd = findFirstMatchingField(ejd, /vej.*navn/i);

              const headerParts = [];
              headerParts.push("Ejendom " + String(idx2 + 1));
              if (bfeVal != null) {
                headerParts.push("BFE: " + String(bfeVal));
              }
              if (matrikel != null) {
                headerParts.push(String(matrikel));
              }

              html += "<details>";
              html += "<summary>" + headerParts.join(" – ") + "</summary>";
              html += "<ul>";
              if (bfeVal != null) {
                html += "<li><strong>BFE-nummer:</strong> " + String(bfeVal) + "</li>";
              }
              if (matrikel != null) {
                html += "<li><strong>Matrikel:</strong> " + String(matrikel) + "</li>";
              }
              if (ejerlav != null) {
                html += "<li><strong>Ejerlav:</strong> " + String(ejerlav) + "</li>";
              }
              if (vejnavnEjd != null) {
                html += "<li><strong>Vejnavn:</strong> " + String(vejnavnEjd) + "</li>";
              }
              if (komNavn != null || komKode != null) {
                let komTekst = "";
                if (komNavn != null) {
                  komTekst = String(komNavn);
                }
                if (komKode != null) {
                  if (komTekst !== "") {
                    komTekst += " (" + String(komKode) + ")";
                  } else {
                    komTekst = String(komKode);
                  }
                }
                html += "<li><strong>Kommune:</strong> " + komTekst + "</li>";
              }
              html += "</ul>";
              html += "<details><summary>Vis rå Ejendomsbeliggenhed-data</summary><pre>" + JSON.stringify(ejd, null, 2) + "</pre></details>";
              html += "</details>";
            });
            html += "</details>";
          }
        }
      } catch (e) {
        console.error("Fejl ved hentning af Ejendomsbeliggenhed:", e);
      }

      html += "</div>"; // .bbr-content slut

      // Tilføj laget til kortet, hvis der er mindst én bygning
      if (bbrBuildingsLayer.getLayers().length > 0) {
        bbrBuildingsLayer.addTo(map);
      }

      bbrBox.innerHTML = html;

      const closeEl = document.getElementById("bbrCloseBtn");
      if (closeEl) {
        closeEl.onclick = hideBBRInfo;
      }
    })
    .catch(err => {
      console.error("BBR render error:", err);
      bbrBox.innerHTML = `
  <div class="bbr-header" style="position: relative;">
    <span class="bbr-title">BBR – bygninger på adressen</span>
    <span id="bbrCloseBtn" class="close">&times;</span>
  </div>
  <p>Fejl ved hentning af BBR-data.</p>
`;
      const closeEl = document.getElementById("bbrCloseBtn");
      if (closeEl) {
        closeEl.onclick = hideBBRInfo;
      }
    });
}

/*
 * Søgefelter og lister
 */
var searchInput  = document.getElementById("search");
var clearBtn     = document.getElementById("clearSearch");
var resultsList  = document.getElementById("results");
var vej1Input    = document.getElementById("vej1");
var vej2Input    = document.getElementById("vej2");
var vej1List     = document.getElementById("results-vej1");
var vej2List     = document.getElementById("results-vej2");

// Checkbox til at styre udenlandsk søgning
var foreignSearchToggle = document.getElementById("enableForeignSearch") || document.getElementById("foreignSearchToggle") || document.getElementById("foreignSearch");
var orsGeocodeQuotaSpan = document.getElementById("orsGeocodeQuota");
if (orsGeocodeQuotaSpan) {
  orsGeocodeQuotaSpan.style.display =
    (foreignSearchToggle && foreignSearchToggle.checked) ? "inline" : "none";
}
if (foreignSearchToggle && orsGeocodeQuotaSpan) {
  foreignSearchToggle.addEventListener("change", function () {
    orsGeocodeQuotaSpan.style.display = this.checked ? "inline" : "none";
  });
}

// Rute-felter
var routeFromInput = document.getElementById("routeFrom");
var routeToInput   = document.getElementById("routeTo");
var routeViaInput  = document.getElementById("routeVia");
var routeFromList  = document.getElementById("results-route-from");
var routeToList    = document.getElementById("results-route-to");
var routeViaList   = document.getElementById("results-route-via");

// Koordinater til rute
var routeFromCoord = null;
var routeToCoord   = null;
var routeViaCoord  = null;

function addClearButton(inputElement, listElement) {
  let btn = document.createElement("span");
  btn.innerHTML = "&times;";
  btn.classList.add("clear-button");
  inputElement.parentElement.appendChild(btn);
  inputElement.addEventListener("input", function () {
    btn.style.display = inputElement.value.length > 0 ? "inline" : "none";
  });
  btn.addEventListener("click", function () {
    inputElement.value = "";
    listElement.innerHTML = "";
    listElement.style.display = "none";
    btn.style.display = "none";
    resetCoordinateBox();
  });
  inputElement.addEventListener("keydown", function (e) {
    if (e.key === "Backspace" && inputElement.value.length === 0) {
      listElement.innerHTML = "";
      listElement.style.display = "none";
      resetCoordinateBox();
    }
  });
  btn.style.display = "none";
}
addClearButton(vej1Input, vej1List);
addClearButton(vej2Input, vej2List);
// Clear-knapper til rute-felter
if (routeFromInput && routeFromList) addClearButton(routeFromInput, routeFromList);
if (routeToInput && routeToList)     addClearButton(routeToInput, routeToList);
if (routeViaInput && routeViaList)   addClearButton(routeViaInput, routeViaList);

/*
 * Globale arrays til piletaster
 */
var searchItems = [];
var searchCurrentIndex = -1;
var vej1Items = [];
var vej1CurrentIndex = -1;
var vej2Items = [];
var vej2CurrentIndex = -1;

// Piletaster til rute-felter
var routeFromItems = [];
var routeFromIndex = -1;
var routeToItems   = [];
var routeToIndex   = -1;
var routeViaItems  = [];
var routeViaIndex  = -1;

/*
 * Route-panel toggling
 */
var routePanel = document.getElementById("routePanel");
var routeToggleBtn = document.getElementById("routeToggleBtn");
if (routeToggleBtn && routePanel) {
  routeToggleBtn.addEventListener("click", function() {
    routePanel.classList.toggle("hidden");
  });
}

/*
 * Hjælper: udfyld rute-felter ved klik på kort
 */
function fillRouteFieldsFromClick(data, lat, lon) {
  if (!routePanel || routePanel.classList.contains("hidden")) return;

  const vejnavn = data?.adgangsadresse?.vejnavn || data.vejnavn || "";
  const husnr   = data?.adgangsadresse?.husnr   || data.husnr   || "";
  const postnr  = data?.adgangsadresse?.postnr  || data.postnr  || "";
  const postnavn = data?.adgangsadresse?.postnrnavn || data.postnrnavn || "";

  if (!vejnavn && !postnr && !postnavn) return;

  const addrText = `${vejnavn} ${husnr}, ${postnr} ${postnavn}`.trim();

  if (routeFromInput && !routeFromInput.value) {
    routeFromInput.value = addrText;
    routeFromCoord = [lat, lon];
  } else if (routeToInput && !routeToInput.value) {
    routeToInput.value = addrText;
    routeToCoord = [lat, lon];
  } else if (routeViaInput) {
    routeViaInput.value = addrText;
    routeViaCoord = [lat, lon];
  }
}

/*
 * Hoved-søg (#search) => doSearch
 */
searchInput.addEventListener("input", function() {
  // Ny søgning: skjul info-bokse, marker mv.
  document.getElementById("infoBox").style.display = "none";
  document.getElementById("statsvejInfoBox").style.display = "none";
  if (!keepMarkersEnabled && currentMarker) {
    map.removeLayer(currentMarker);
    currentMarker = null;
  }
  resetCoordinateBox();

  const txt = searchInput.value.trim();
  if (txt.length < 2) {
    clearBtn.style.display = "none";
    resultsList.innerHTML = "";
    resultsList.style.display = "none"; // VIGTIGT: skjul listen helt
    document.getElementById("infoBox").style.display = "none";
    searchItems = [];
    return;
  }
  clearBtn.style.display = "inline";
  doSearch(txt, resultsList);
  
  const coordRegex = /^(-?\d+(?:\.\d+))\s*,\s*(-?\d+(?:\.\d+))$/;
  if (coordRegex.test(txt)) {
    const match = txt.match(coordRegex);
    const latNum = parseFloat(match[1]);
    const lonNum = parseFloat(match[2]);
    let revUrl = `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${lonNum}&y=${latNum}&struktur=flad`;
    fetch(revUrl)
      .then(r => r.json())
      .then(data => {
        resultsList.innerHTML = "";
        resultsList.style.display = "none";
        placeMarkerAndZoom([latNum, lonNum], `Koordinater: ${latNum.toFixed(5)}, ${lonNum.toFixed(5)}`);
        setCoordinateBox(latNum, lonNum);
        updateInfoBox(data, latNum, lonNum);
      })
      .catch(err => console.error("Reverse geocoding fejl:", err));
    return;
  }
});

searchInput.addEventListener("keydown", function(e) {
  if (e.key === "ArrowDown") {
    if (searchItems.length === 0) return;
    e.preventDefault();
    searchCurrentIndex = (searchCurrentIndex + 1) % searchItems.length;
    highlightSearchItem();
  } else if (e.key === "ArrowUp") {
    if (searchItems.length === 0) return;
    e.preventDefault();
    searchCurrentIndex = (searchCurrentIndex + searchItems.length - 1) % searchItems.length;
    highlightSearchItem();
  } else if (e.key === "Enter") {
    if (searchItems.length === 0) return;
    e.preventDefault();
    if (searchCurrentIndex >= 0) {
      searchItems[searchCurrentIndex].click();
    }
  } else if (e.key === "Backspace") {
    // Når feltet bliver tømt med backspace, skal resultatliste, markør, BBR og infobokse væk
    const currentLength = searchInput.value.length; // længde før tegnet slettes
    if (currentLength <= 1) {
      resultsList.innerHTML = "";
      resultsList.style.display = "none";
      searchItems = [];
      searchCurrentIndex = -1;

      document.getElementById("infoBox").style.display = "none";
      document.getElementById("statsvejInfoBox").style.display = "none";
      document.getElementById("kommuneOverlay").style.display = "none";
      resetCoordinateBox();

      hideBBRInfo();

      if (!keepMarkersEnabled && currentMarker) {
        map.removeLayer(currentMarker);
        currentMarker = null;
      }
    }
  }
});

function highlightSearchItem() {
  searchItems.forEach(li => li.classList.remove("highlight"));
  if (searchCurrentIndex >= 0 && searchCurrentIndex < searchItems.length) {
    searchItems[searchCurrentIndex].classList.add("highlight");
  }
}

clearBtn.addEventListener("click", function() {
  searchInput.value = "";
  clearBtn.style.display = "none";
  document.getElementById("infoBox").style.display = "none";
  document.getElementById("statsvejInfoBox").style.display = "none";
  hideBBRInfo();
  resetCoordinateBox();
  resetInfoBox();
  searchInput.focus();
  if (!keepMarkersEnabled && currentMarker) {
    map.removeLayer(currentMarker);
    currentMarker = null;
  }
  resultsList.innerHTML = "";
  resultsList.style.display = "none";
  document.getElementById("kommuneOverlay").style.display = "none";
});

/*
 * Vej1 / Vej2
 */
vej1Input.addEventListener("input", function() {
  const txt = vej1Input.value.trim();
  if (txt.length < 2) {
    vej1List.innerHTML = "";
    vej1List.style.display = "none";
    vej1Items = [];
    return;
  }
  doSearchRoad(txt, vej1List, vej1Input, "vej1");
});
vej1Input.addEventListener("keydown", function(e) {
  if (e.key === "Backspace") {
    document.getElementById("infoBox").style.display = "none";
  }
  if (vej1Items.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    vej1CurrentIndex = (vej1CurrentIndex + 1) % vej1Items.length;
    highlightVej1Item();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    vej1CurrentIndex = (vej1CurrentIndex + vej1Items.length - 1) % vej1Items.length;
    highlightVej1Item();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (vej1CurrentIndex >= 0) {
      vej1Items[vej1CurrentIndex].click();
    }
  }
});
function highlightVej1Item() {
  vej1Items.forEach(li => li.classList.remove("highlight"));
  if (vej1CurrentIndex >= 0 && vej1CurrentIndex < vej1Items.length) {
    vej1Items[vej1CurrentIndex].classList.add("highlight");
  }
}

vej2Input.addEventListener("input", function() {
  const txt = vej2Input.value.trim();
  if (txt.length < 2) {
    vej2List.innerHTML = "";
    vej2List.style.display = "none";
    vej2Items = [];
    return;
  }
  doSearchRoad(txt, vej2List, vej2Input, "vej2");
});
vej2Input.addEventListener("keydown", function(e) {
  document.getElementById("infoBox").style.display = "none";
  if (vej2Items.length === 0) {
    if (e.key === "Backspace" && vej2Input.value.length === 0) {
      resetCoordinateBox();
      vej2List.innerHTML = "";
      vej2List.style.display = "none";
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    vej2CurrentIndex = (vej2CurrentIndex + 1) % vej2Items.length;
    highlightVej2Item();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    vej2CurrentIndex = (vej2CurrentIndex + vej2Items.length - 1) % vej2Items.length;
    highlightVej2Item();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (vej2CurrentIndex >= 0) {
      vej2Items[vej2CurrentIndex].click();
    }
  } else if (e.key === "Backspace") {
    if (vej2Input.value.length === 0) {
      resetCoordinateBox();
      vej2List.innerHTML = "";
      vej2List.style.display = "none";
    }
  }
});
function highlightVej2Item() {
  vej2Items.forEach(li => li.classList.remove("highlight"));
  if (vej2CurrentIndex >= 0 && vej2CurrentIndex < vej2Items.length) {
    vej2Items[vej2CurrentIndex].classList.add("highlight");
  }
}

function resetInfoBox() {
  document.getElementById("extra-info").textContent = "";
  document.getElementById("skraafotoLink").style.display = "none";
}

vej1Input.parentElement.querySelector(".clear-button").addEventListener("click", function() {
  vej1Input.value = "";
  vej1List.innerHTML = "";
  vej1List.style.display = "none";
  document.getElementById("infoBox").style.display = "none";
  resetCoordinateBox();
});

vej2Input.parentElement.querySelector(".clear-button").addEventListener("click", function() {
  vej2Input.value = "";
  vej2List.innerHTML = "";
  vej2List.style.display = "none";
  document.getElementById("infoBox").style.display = "none";
  resetCoordinateBox();
});

/*
 * Rute-felter: søgning i Dataforsyningen
 */
function doRouteSearch(query, listElement, type) {
  let url = `https://api.dataforsyningen.dk/adgangsadresser/autocomplete?q=${encodeURIComponent(query)}&per_side=10`;
  fetch(url)
    .then(response => response.json())
    .then(data => {
      listElement.innerHTML = "";

      let itemsArray;
      if (type === "from") {
        routeFromItems = [];
        routeFromIndex = -1;
        itemsArray = routeFromItems;
      } else if (type === "to") {
        routeToItems = [];
        routeToIndex = -1;
        itemsArray = routeToItems;
      } else {
        routeViaItems = [];
        routeViaIndex = -1;
        itemsArray = routeViaItems;
      }

      data.forEach(item => {
        let li = document.createElement("li");
        li.textContent = item.tekst;
        li.addEventListener("click", function() {
          selectRouteSuggestion(item, type, listElement);
        });
        listElement.appendChild(li);
        itemsArray.push(li);
      });
      listElement.style.display = data.length > 0 ? "block" : "none";
    })
    .catch(err => console.error("Fejl i doRouteSearch:", err));
}

function selectRouteSuggestion(item, type, listElement) {
  const input = type === "from" ? routeFromInput : type === "to" ? routeToInput : routeViaInput;
  input.value = item.tekst || "";
  listElement.innerHTML = "";
  listElement.style.display = "none";

  const adgangsId = item.adgangsadresse && item.adgangsadresse.id;
  if (!adgangsId) {
    console.error("Ingen adgangsadresse.id for rute-forslag");
    return;
  }
  const detailUrl = `https://api.dataforsyningen.dk/adgangsadresser/${adgangsId}`;
  fetch(detailUrl)
    .then(r => r.json())
    .then(addr => {
      let coords = addr.adgangspunkt?.koordinater;
      if (!coords || coords.length < 2) return;
      const lon = coords[0];
      const lat = coords[1];
      if (type === "from") {
        routeFromCoord = [lat, lon];
      } else if (type === "to") {
        routeToCoord = [lat, lon];
      } else {
        routeViaCoord = [lat, lon];
      }
    })
    .catch(err => console.error("Fejl i selectRouteSuggestion:", err));
}

function highlightRouteItem(type) {
  let items, idx;
  if (type === "from") {
    items = routeFromItems;
    idx = routeFromIndex;
  } else if (type === "to") {
    items = routeToItems;
    idx = routeToIndex;
  } else {
    items = routeViaItems;
    idx = routeViaIndex;
  }
  if (!items) return;
  items.forEach(li => li.classList.remove("highlight"));
  if (idx >= 0 && idx < items.length) {
    items[idx].classList.add("highlight");
  }
}

function setupRouteInputHandlers(inputElement, listElement, type) {
  if (!inputElement || !listElement) return;

  inputElement.addEventListener("input", function() {
    const txt = inputElement.value.trim();
    if (txt.length < 2) {
      listElement.innerHTML = "";
      listElement.style.display = "none";
      if (type === "from") {
        routeFromItems = [];
        routeFromIndex = -1;
        routeFromCoord = null;
      } else if (type === "to") {
        routeToItems = [];
        routeToIndex = -1;
        routeToCoord = null;
      } else {
        routeViaItems = [];
        routeViaIndex = -1;
        routeViaCoord = null;
      }
      return;
    }
    doRouteSearch(txt, listElement, type);
  });

  inputElement.addEventListener("keydown", function(e) {
    let items;
    if (type === "from") {
      items = routeFromItems;
    } else if (type === "to") {
      items = routeToItems;
    } else {
      items = routeViaItems;
    }
    if (!items || items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (type === "from") {
        routeFromIndex = (routeFromIndex + 1) % items.length;
      } else if (type === "to") {
        routeToIndex = (routeToIndex + 1) % items.length;
      } else {
        routeViaIndex = (routeViaIndex + 1) % items.length;
      }
      highlightRouteItem(type);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (type === "from") {
        routeFromIndex = (routeFromIndex + items.length - 1) % items.length;
      } else if (type === "to") {
        routeToIndex = (routeToIndex + items.length - 1) % items.length;
      } else {
        routeViaIndex = (routeViaIndex + items.length - 1) % items.length;
      }
      highlightRouteItem(type);
    } else if (e.key === "Enter") {
      e.preventDefault();
      let idx;
      if (type === "from") idx = routeFromIndex;
      else if (type === "to") idx = routeToIndex;
      else idx = routeViaIndex;

      if (idx >= 0 && idx < items.length) {
        items[idx].click();
      }
    }
  });
}

setupRouteInputHandlers(routeFromInput, routeFromList, "from");
setupRouteInputHandlers(routeToInput,   routeToList,   "to");
setupRouteInputHandlers(routeViaInput,  routeViaList,  "via");

/*
 * Globale variabler til at gemme valgte veje (Find X)
 */
var selectedRoad1 = null;
var selectedRoad2 = null;

/*
 * doSearchRoad => bruges af vej1/vej2
 */
function doSearchRoad(query, listElement, inputField, which) {
  let addrUrl = `https://api.dataforsyningen.dk/adgangsadresser/autocomplete?q=${encodeURIComponent(query)}&per_side=10`;
  fetch(addrUrl)
    .then(response => response.json())
    .then(data => {
      listElement.innerHTML = "";
      if (which === "vej1") {
        vej1Items = [];
        vej1CurrentIndex = -1;
      } else {
        vej2Items = [];
        vej2CurrentIndex = -1;
      }
      data.sort((a, b) => a.tekst.localeCompare(b.tekst));
      const unique = new Set();
      data.forEach(item => {
        let vejnavn   = item.adgangsadresse?.vejnavn || "Ukendt vej";
        let kommune   = item.adgangsadresse?.postnrnavn || "Ukendt kommune";
        let postnr    = item.adgangsadresse?.postnr || "?";
        let adgangsId = item.adgangsadresse?.id || null;
        let key = `${vejnavn}-${postnr}`;
        if (unique.has(key)) return;
        unique.add(key);
        let li = document.createElement("li");
        li.textContent = `${vejnavn}, ${kommune} (${postnr})`;
        li.addEventListener("click", function() {
          inputField.value = vejnavn;
          listElement.innerHTML = "";
          listElement.style.display = "none";
          if (!adgangsId) {
            console.error("Ingen adgangsadresse.id => kan ikke slå vejkode op");
            return;
          }
          let detailUrl = `https://api.dataforsyningen.dk/adgangsadresser/${adgangsId}?struktur=mini`;
          fetch(detailUrl)
            .then(r => r.json())
            .then(async detailData => {
              let roadSelection = {
                vejnavn: vejnavn,
                kommunekode: detailData.kommunekode,
                vejkode: detailData.vejkode,
                husnummerId: detailData.id
              };
              let geometry = await getNavngivenvejKommunedelGeometry(detailData.id);
              roadSelection.geometry = geometry;
              if (inputField.id === "vej1") {
                selectedRoad1 = roadSelection;
              } else if (inputField.id === "vej2") {
                selectedRoad2 = roadSelection;
              }
            })
            .catch(err => {
              console.error("Fejl i fetch /adgangsadresser/{id}:", err);
            });
        });
        listElement.appendChild(li);
        if (which === "vej1") {
          vej1Items.push(li);
        } else {
          vej2Items.push(li);
        }
      });
      listElement.style.display = data.length > 0 ? "block" : "none";
    })
    .catch(err => console.error("Fejl i doSearchRoad:", err));
}

/*
 * doSearchStrandposter => klient-side søgning
 */
function doSearchStrandposter(query) {
  query = query.toLowerCase();
  return new Promise((resolve) => {
    function filterAndMap() {
      let results = allStrandposter.filter(feature => {
        let rednr = (feature.properties.StrandNr || "").toLowerCase();
        return rednr.indexOf(query) !== -1;
      }).map(feature => {
        let rednr = feature.properties.StrandNr;
        let tekst = `Redningsnummer: ${rednr}`;
        let coords = feature.geometry.coordinates;
        let lat, lon;
        if (coords[0] > 90 || coords[1] > 90) {
          let converted = convertToWGS84(coords[0], coords[1]);
          lat = converted[0];
          lon = converted[1];
        } else {
          lon = coords[0];
          lat = coords[1];
        }
        return {
          type: "strandpost",
          tekst: tekst,
          lat: lat,
          lon: lon,
          feature: feature
        };
      });
      resolve(results);
    }
    if (allStrandposter.length === 0) {
      fetchAllStrandposter().then(filterAndMap).catch(err => {
        console.error("Fejl ved hentning af strandposter:", err);
        resolve([]);
      });
    } else {
      filterAndMap();
    }
  });
}

/*
 * doSearch => kombinerer adresser, stednavne, specialsteder,
 * navngivne veje, strandposter og udenlandske ORS-adresser
 */
/*
 * doSearch => kombinerer adresser (enheds-adresser), stednavne, specialsteder,
 * navngivne veje, strandposter og udenlandske ORS-adresser
 *
 * Adresser hentes nu via /adresser/autocomplete, så forslagene indeholder
 * etage/dør. Ved klik slås den fulde adresse op via /adresser/{id}, og
 * husnummer-id bruges til BBR-opslag.
 */
function doSearch(query, listElement) {
  // Enhedsadresser i stedet for adgangsadresser
  let addrUrl = `https://api.dataforsyningen.dk/adresser/autocomplete?q=${encodeURIComponent(query)}&per_side=20`;
  let stedUrl = `https://api.dataforsyningen.dk/rest/gsearch/v2.0/stednavn?q=${encodeURIComponent(query)}&limit=100&token=a63a88838c24fc85d47f32cde0ec0144`;
  const queryWithWildcard = query.trim().split(/\s+/).map(w => w + "*").join(" ");
  let roadUrl = `https://api.dataforsyningen.dk/navngivneveje?q=${encodeURIComponent(queryWithWildcard)}&per_side=20`;

  // Strandposter (kun når laget er tændt og data er klar)
  let strandPromiseBase = (map.hasLayer(redningsnrLayer) && strandposterReady)
    ? doSearchStrandposter(query)
    : Promise.resolve([]);

  // Evt. egne special-steder
  let customResults = customPlaces
    .filter(p => p.navn.toLowerCase().includes(query.toLowerCase()))
    .map(p => ({
      type: "custom",
      navn: p.navn,
      coords: p.coords
    }));

  // Udlands-tilstand styres af checkboxen (Udland)
  const foreignToggleEl =
    foreignSearchToggle ||
    document.getElementById("enableForeignSearch") ||
    document.getElementById("foreignSearchToggle") ||
    document.getElementById("foreignSearch");
  const foreignOnly = !!(foreignToggleEl && foreignToggleEl.checked);

  // Promises til de forskellige datakilder
  let addrPromise;
  let stedPromise;
  let roadPromise;
  let strandPromise;
  let orsPromise;

  if (foreignOnly) {
    // Når "Udland" er slået til:
    //  - ingen Dataforsyningen-søgninger
    //  - kun ORS (udenlandske adresser)
    addrPromise   = Promise.resolve([]);
    stedPromise   = Promise.resolve({});
    roadPromise   = Promise.resolve([]);
    strandPromise = Promise.resolve([]);
    orsPromise    = geocodeORSForSearch(query);
  } else {
    // Normal tilstand: danske kilder, ingen ORS
    addrPromise = fetch(addrUrl)
      .then(r => r.json())
      .catch(err => { console.error("Adresser fejl:", err); return []; });

    stedPromise = fetch(stedUrl)
      .then(r => r.json())
      .catch(err => { console.error("Stednavne fejl:", err); return {}; });

    roadPromise = fetch(roadUrl)
      .then(r => r.json())
      .catch(err => { console.error("Navngivne veje fejl:", err); return []; });

    strandPromise = strandPromiseBase;

    // ORS skal ikke kaldes, når Udland ikke er valgt
    orsPromise = Promise.resolve([]);
  }

  Promise.all([
    addrPromise,
    stedPromise,
    roadPromise,
    strandPromise,
    orsPromise
  ])
  .then(([addrData, stedData, roadData, strandData, orsData]) => {
    listElement.innerHTML = "";
    searchItems = [];
    searchCurrentIndex = -1;

    // Adresser (enheds-adresser fra Dataforsyningen)
    let addrResults = (addrData || []).map(item => {
      // /adresser/autocomplete returnerer normalt { tekst, adresse: { ... } }
      const adresseObj = item.adresse || item;
      const tekst = item.tekst ||
                    adresseObj.tekst ||
                    adresseObj.adressebetegnelse ||
                    "";
      const enhedsId = adresseObj.id || null;

      let adgangsadresseId = null;
      if (adresseObj.adgangsadresse && adresseObj.adgangsadresse.id) {
        adgangsadresseId = adresseObj.adgangsadresse.id;
      } else if (adresseObj.adgangsadresseid) {
        adgangsadresseId = adresseObj.adgangsadresseid;
      } else if (adresseObj.husnummerid) {
        adgangsadresseId = adresseObj.husnummerid;
      }

      return {
        type: "adresse",
        tekst: tekst,
        adresse: adresseObj,
        enhedsId: enhedsId,
        adgangsadresseId: adgangsadresseId
      };
    });

    // Stednavne
    let stedResults = [];
    if (stedData) {
      if (Array.isArray(stedData.results)) {
        stedResults = stedData.results.map(result => ({
          type: "stednavn",
          navn: result.visningstekst || result.navn,
          bbox: result.bbox || null,
          geometry: result.geometry
        }));
      } else if (Array.isArray(stedData)) {
        stedResults = stedData.map(result => ({
          type: "stednavn",
          navn: result.visningstekst || result.skrivemaade_officiel,
          bbox: result.bbox || null,
          geometry: result.geometri
        }));
      }
    }

    // Navngivne veje
    let roadResults = (roadData || []).map(item => ({
      type: "navngivenvej",
      navn: item.navn || item.adresseringsnavn || "",
      id: item.id,
      visualCenter: item.visueltcenter,
      bbox: item.bbox
    }));

    // Udenlandske adresser fra ORS
    let orsResults = (orsData || []).map(o => o);

    // Samlet liste
    let combined;
    if (foreignOnly) {
      // Når "Udland" er slået til: KUN udenlandske adresser
      combined = [
        ...orsResults
      ];
    } else {
      // Normal tilstand: danske kilder + evt. egne steder
      combined = [
        ...addrResults,
        ...stedResults,
        ...roadResults,
        ...(strandData || []),
        ...customResults,
        ...orsResults
      ];
    }

    // Sortering (som før)
    combined.sort((a, b) => {
      const aIsName = (a.type === "stednavn" || a.type === "navngivenvej" || a.type === "custom" || a.type === "ors_foreign");
      const bIsName = (b.type === "stednavn" || b.type === "navngivenvej" || b.type === "custom" || b.type === "ors_foreign");
      if (aIsName && !bIsName) return -1;
      if (!aIsName && bIsName) return 1;
      return getSortPriority(a, query) - getSortPriority(b, query);
    });

    // Byg liste-elementer
    combined.forEach(obj => {
      let li = document.createElement("li");
      if (obj.type === "strandpost") {
        li.innerHTML = `🛟 ${obj.tekst}`;
      } else if (obj.type === "adresse") {
        li.innerHTML = `🏠 ${obj.tekst}`;
      } else if (obj.type === "navngivenvej") {
        li.innerHTML = `🛣️ ${obj.navn}`;
      } else if (obj.type === "stednavn" || obj.type === "custom") {
        li.innerHTML = `📍 ${obj.navn}`;
      } else if (obj.type === "ors_foreign") {
        li.innerHTML = `🌍 ${obj.label}`;
      }

      li.addEventListener("click", function() {
        // ENHEDSADRESSE: hent fuld adresse via /adresser/{id}
        if (obj.type === "adresse" && (obj.enhedsId || (obj.adresse && obj.adresse.id))) {
          const adresseId = obj.enhedsId || (obj.adresse && obj.adresse.id);
          if (!adresseId) {
            console.error("Ingen enheds-adresse-id tilgængelig for adresse-resultat");
            return;
          }

          fetch(`https://api.dataforsyningen.dk/adresser/${adresseId}`)
            .then(r => r.json())
            .then(adresseData => {
              // NYT – sæt husnummerId eksplicit til brug for BBR-opslag
              if (!adresseData.husnummerId) {
                if (adresseData.husnummerid) {
                  adresseData.husnummerId = adresseData.husnummerid;
                } else if (adresseData.adgangsadresseid) {
                  adresseData.husnummerId = adresseData.adgangsadresseid;
                } else if (adresseData.adgangsadresse && adresseData.adgangsadresse.id) {
                  adresseData.husnummerId = adresseData.adgangsadresse.id;
                }
              }

              // Koordinater tages fra adgangsadresse.adgangspunkt.koordinater
              let coords = null;
              if (adresseData.adgangsadresse &&
                  adresseData.adgangsadresse.adgangspunkt &&
                  Array.isArray(adresseData.adgangsadresse.adgangspunkt.koordinater)) {
                coords = adresseData.adgangsadresse.adgangspunkt.koordinater;
              } else if (adresseData.adgangsadresse &&
                         Array.isArray(adresseData.adgangsadresse.koordinater)) {
                // Fallback hvis strukturen er anderledes
                coords = adresseData.adgangsadresse.koordinater;
              }

              if (!coords || coords.length < 2) {
                console.error("Kunne ikke finde koordinater for adresse:", adresseData);
                return;
              }

              const lon = coords[0];
              const lat = coords[1];

              setCoordinateBox(lat, lon);
              // Vis enheds-adressen (inkl. etage/dør) i titel-linjen
              placeMarkerAndZoom([lat, lon], obj.tekst);

              // Opdater infoboksen:
              //  - adresseData giver adgang til husnummerId til BBR
              //  - obj.tekst bruges som visnings-tekst (enheds-adresse)
              updateInfoBox(adresseData, lat, lon, obj.tekst);

              resultsList.innerHTML = "";
              resultsList.style.display = "none";
              vej1List.innerHTML = "";
              vej2List.innerHTML = "";
            })
            .catch(err => console.error("Fejl i /adresser/{id}:", err));
        } else if (obj.type === "stednavn" && obj.bbox && obj.bbox.coordinates && obj.bbox.coordinates[0] && obj.bbox.coordinates[0].length > 0) {
          let [x, y] = obj.bbox.coordinates[0][0];
          placeMarkerAndZoom([x, y], obj.navn);
          listElement.innerHTML = "";
          listElement.style.display = "none";
        } else if (obj.type === "stednavn" && obj.geometry && obj.geometry.coordinates) {
          let coordsArr = Array.isArray(obj.geometry.coordinates[0])
                          ? obj.geometry.coordinates[0]
                          : obj.geometry.coordinates;
          placeMarkerAndZoom(coordsArr, obj.navn);
          listElement.innerHTML = "";
          listElement.style.display = "none"; 
        } else if (obj.type === "strandpost") {
          setCoordinateBox(obj.lat, obj.lon);
          placeMarkerAndZoom([obj.lat, obj.lon], obj.tekst);
          listElement.innerHTML = "";
          listElement.style.display = "none"; 
          let marker = currentMarker;
          let revUrl = `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${obj.lon}&y=${obj.lat}&struktur=flad`;
          fetch(revUrl)
            .then(r => r.json())
            .then(revData => {
              const vejnavn     = revData?.adgangsadresse?.vejnavn     || revData?.vejnavn || "?";
              const husnr       = revData?.adgangsadresse?.husnr       || revData?.husnr   || "";
              const postnr      = revData?.adgangsadresse?.postnr      || revData?.postnr  || "?";
              const postnrnavn  = revData?.adgangsadresse?.postnrnavn  || revData?.postnrnavn || "";
              const adresseStr  = `${vejnavn} ${husnr}, ${postnr} ${postnrnavn}`;
              const evaFormat   = `${vejnavn},${husnr},${postnr}`;
              const notesFormat = `${vejnavn} ${husnr}, ${postnr} ${postnrnavn}`;
              marker.bindPopup(`
                <strong>${obj.tekst}</strong><br>
                ${adresseStr}<br>
                <a href="#" title="Kopier til Eva.net" onclick="(function(el){ el.style.color='red'; copyToClipboard('${evaFormat}'); showCopyPopup('Kopieret'); setTimeout(function(){ el.style.color=''; },1000); })(this); return false;">Eva.Net</a>
              `).openPopup();
              marker.on("popupclose", function () {
                map.removeLayer(marker);
                currentMarker = null;
                document.getElementById("infoBox").style.display = "none";
                document.getElementById("statsvejInfoBox").style.display = "none";
                resetCoordinateBox();
                resultsList.innerHTML = "";
                resultsList.style.display = "none";
              });
            })
            .catch(err => {
              console.error("Reverse geocoding for strandpost fejlede:", err);
              marker.bindPopup(`<strong>${obj.tekst}</strong><br>(Reverse geocoding fejlede)`).openPopup();
            });
        } else if (obj.type === "custom") {
          let [lat, lon] = obj.coords;
          setCoordinateBox(lat, lon);
          placeMarkerAndZoom([lat, lon], obj.navn);
          let revUrl = `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${lon}&y=${lat}&struktur=flad`;
          fetch(revUrl)
            .then(r => r.json())
            .then(revData => {
              updateInfoBox(revData, lat, lon);
            })
            .catch(err => console.error("Reverse geocoding fejl for specialsted:", err));
          listElement.innerHTML = "";
          listElement.style.display = "none";
        } else if (obj.type === "navngivenvej") {
          let lat, lon;
          if (Array.isArray(obj.visualCenter) && obj.visualCenter.length === 2) {
            lon = obj.visualCenter[0];
            lat = obj.visualCenter[1];
          } else if (Array.isArray(obj.bbox) && obj.bbox.length === 4) {
            const [minLon, minLat, maxLon, maxLat] = obj.bbox;
            lon = (minLon + maxLon) / 2;
            lat = (minLat + maxLat) / 2;
          } else {
            return;
          }
          setCoordinateBox(lat, lon);
          placeMarkerAndZoom([lat, lon], obj.navn);
          let revUrl = `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${lon}&y=${lat}&struktur=flad`;
          fetch(revUrl)
            .then(r => r.json())
            .then(revData => {
              updateInfoBox(revData, lat, lon);
            })
            .catch(err => console.error("Reverse geocoding fejl for navngiven vej:", err));
          listElement.innerHTML = "";
          listElement.style.display = "none";
        } else if (obj.type === "ors_foreign") {
          // Udenlandsk adresse fra ORS
          const lat = obj.lat;
          const lon = obj.lon;
          setCoordinateBox(lat, lon);
          placeMarkerAndZoom([lat, lon], obj.label);
          updateInfoBoxForeign(obj.feature, lat, lon);

          // Udfyld rute-felter
          const p = obj.feature.properties || {};
          const norm = {
            vejnavn: p.street || p.name || "",
            husnr: p.housenumber || "",
            postnr: p.postalcode || "",
            postnrnavn: p.locality || p.region || p.country || ""
          };
          fillRouteFieldsFromClick(norm, lat, lon);

          listElement.innerHTML = "";
          listElement.style.display = "none";
        }
      });

      listElement.appendChild(li);
      searchItems.push(li);
    });

    listElement.style.display = combined.length > 0 ? "block" : "none";
  })
  .catch(err => console.error("Fejl i doSearch:", err));
}

/*
 * getNavngivenvejKommunedelGeometry
 */
async function getNavngivenvejKommunedelGeometry(husnummerId) {
  let url = `https://services.datafordeler.dk/DAR/DAR/3.0.0/rest/navngivenvejkommunedel?husnummer=${husnummerId}&MedDybde=true&format=json`;
  try {
    let r = await fetch(url);
    let data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      let first = data[0];
      if (first.navngivenVej && first.navngivenVej.vejnavnebeliggenhed_vejnavnelinje) {
        let wktString = first.navngivenVej.vejnavnebeliggenhed_vejnavnelinje;
        let geojson = wellknown.parse(wktString);
        return geojson;
      }
    }
  } catch (err) {
    console.error("Fejl i getNavngivenvejKommunedelGeometry:", err);
  }
  return null;
}

/*
 * placeMarkerAndZoom – bruger createSelectionMarker
 */
function placeMarkerAndZoom(coords, displayText) {
  if (coords[0] > 90 || coords[1] > 90) {
    let converted = convertToWGS84(coords[0], coords[1]);
    coords = converted;
  }
  let lat = coords[0], lon = coords[1];

  // Brug fælles helper, så den respekterer "Behold markører"
  createSelectionMarker(lat, lon);

  map.setView([lat, lon], 16);
  document.getElementById("address").textContent = displayText;
  const streetviewLink = document.getElementById("streetviewLink");
  streetviewLink.href = `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lon}`;
  document.getElementById("infoBox").style.display = "block";
}

/*
 * checkForStatsvej
 */
async function checkForStatsvej(lat, lon) {
  let [utmX, utmY] = proj4("EPSG:4326", "EPSG:25832", [lon, lat]);
  let buffer = 100;
  let bbox = `${utmX - buffer},${utmY - buffer},${utmX + buffer},${utmY + buffer}`;
  let url = `https://geocloud.vd.dk/CVF/wms?
SERVICE=WMS&
VERSION=1.1.1&
REQUEST=GetFeatureInfo&
INFO_FORMAT=application/json&
TRANSPARENT=true&
LAYERS=CVF:veje&
QUERY_LAYERS=CVF:veje&
SRS=EPSG:25832&
WIDTH=101&
HEIGHT=101&
BBOX=${bbox}&
X=50&
Y=50`;
  try {
    let response = await fetch(url);
    let textData = await response.text();
    if (textData.startsWith("Results")) {
      let extractedData = parseTextResponse(textData);
      return extractedData;
    }
    let jsonData = JSON.parse(textData);
    if (jsonData.features && jsonData.features.length > 0) {
      return jsonData.features[0].properties;
    } else {
      return {};
    }
  } catch (error) {
    console.error("Fejl ved hentning af vejdata:", error);
    return {};
  }
}

function parseTextResponse(text) {
  let lines = text.split("\n");
  let data = {};
  lines.forEach(line => {
    let parts = line.split(" = ");
    if (parts.length === 2) {
      let key = parts[0].trim();
      let value = parts[1].trim();
      data[key] = value;
    }
  });
  return data;
}

/*
 * getKmAtPoint – henter km via Cloudflare-worker
 */
async function getKmAtPoint(lat, lon) {
  try {
    const [x, y] = proj4("EPSG:4326", "EPSG:25832", [lon, lat]);
    const stats = await checkForStatsvej(lat, lon);
    const roadNumber = stats.ADM_NR ?? stats.adm_nr ?? null;
    const roadPart   = stats.FORGRENING ?? stats.forgrening ?? 0;
    if (!roadNumber) return "";
    const url =
      `${VD_PROXY}/reference` +
      `?geometry=POINT(${x}%20${y})` +
      `&srs=EPSG:25832` +
      `&roadNumber=${roadNumber}` +
      `&roadPart=${roadPart}` +
      `&format=json`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) {
      return "";
    }
    const data = await resp.json();
    const props =
      data?.properties ??
      data?.feature?.properties ??
      data?.features?.[0]?.properties ??
      data;
    const from = props?.from ?? props?.FROM ?? props?.fra ?? props?.at ?? null;
    const to   = props?.to   ?? props?.TO   ?? props?.til ?? null;
    const kmtText =
      from?.kmtText ?? from?.KMTTEXT ??
      to?.kmtText   ?? to?.KMTTEXT   ??
      props?.kmtText ?? props?.KMTEKST ?? props?.kmtekst ??
      props?.KM_TEXT ?? props?.km_text ?? props?.kmtegn ??
      null;
    if (kmtText) return String(kmtText);
    const km = (from?.km ?? props?.km ?? props?.KM ?? null);
    const m  = (from?.m  ?? props?.m  ?? props?.M  ?? props?.km_meter ?? null);
    if (km != null && m != null) {
      return `${km}/${String(m).padStart(4, "0")}`;
    }
    return "";
  } catch (e) {
    console.error("getKmAtPoint fejl:", e);
    return "";
  }
}

/*
 * Statsvej / info-bokse close-knapper
 */
const statsvejInfoBox = document.getElementById("statsvejInfoBox");
const statsvejCloseBtn = document.getElementById("statsvejCloseBtn");
statsvejCloseBtn.addEventListener("click", function() {
  statsvejInfoBox.style.display = "none";
  document.getElementById("infoBox").style.display = "none";
  hideBBRInfo();
  resetCoordinateBox();
  if (!keepMarkersEnabled && currentMarker) {
    map.removeLayer(currentMarker);
    currentMarker = null;
  }
});

const infoCloseBtn = document.getElementById("infoCloseBtn");
infoCloseBtn.addEventListener("click", function() {
  document.getElementById("infoBox").style.display = "none";
  document.getElementById("statsvejInfoBox").style.display = "none";

  if (!keepMarkersEnabled && currentMarker) {
    map.removeLayer(currentMarker);
    currentMarker = null;
  }

  resetCoordinateBox();

  resultsList.innerHTML = "";
  resultsList.style.display = "none";
  document.getElementById("kommuneOverlay").style.display = "none";

   // Skjul også BBR-infoboksen når infoboksen lukkes
  hideBBRInfo();
});

/*
 * "Find X"-knap => find intersection med Turf.js
 */
document.getElementById("findKrydsBtn").addEventListener("click", async function() {
  if (!selectedRoad1 || !selectedRoad2) {
    alert("Vælg venligst to veje først.");
    return;
  }
  if (!selectedRoad1.geometry || !selectedRoad2.geometry) {
    alert("Geometri ikke tilgængelig for en eller begge veje.");
    return;
  }
  let line1 = turf.multiLineString(selectedRoad1.geometry.coordinates);
  let line2 = turf.multiLineString(selectedRoad2.geometry.coordinates);
  let intersection = turf.lineIntersect(line1, line2);
  if (intersection.features.length === 0) {
    alert("De valgte veje krydser ikke hinanden.");
  } else {
    let latLngs = [];
    for (let i = 0; i < intersection.features.length; i++) {
      let feat = intersection.features[i];
      let coords = feat.geometry.coordinates;
      let [wgsLon, wgsLat] = proj4("EPSG:25832", "EPSG:4326", [coords[0], coords[1]]);
      latLngs.push([wgsLat, wgsLon]);
      let revUrl = `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${wgsLon}&y=${wgsLat}&struktur=flad`;
      let marker = L.marker([wgsLat, wgsLon]).addTo(map);
      try {
        let resp = await fetch(revUrl);
        let revData = await resp.json();
        let addressStr = `${revData.vejnavn || "Ukendt"} ${revData.husnr || ""}, ${revData.postnr || "?"} ${revData.postnrnavn || ""}`;
        let evaFormat = `${revData.vejnavn || ""},${revData.husnr || ""},${revData.postnr || ""}`;
        let notesFormat = `${revData.vejnavn || ""} ${revData.husnr || ""}, ${revData.postnr || ""} ${revData.postnrnavn || ""}`;
        marker.bindPopup(`
          ${addressStr}<br>
          <a href="#" title="Kopier til Eva.net" onclick="(function(el){ el.style.color='red'; copyToClipboard('${evaFormat}'); showCopyPopup('Kopieret'); setTimeout(function(){ el.style.color=''; },1000); })(this); return false;">Eva.Net</a>
        `).openPopup();
      } catch (err) {
        console.error("Reverse geocoding fejl ved vejkryds:", err);
        marker.bindPopup(`(${wgsLat.toFixed(6)}, ${wgsLon.toFixed(6)})<br>Reverse geocoding fejlede.`).openPopup();
      }
      setCoordinateBox(wgsLat, wgsLon);
      marker.on("popupclose", function() {
        map.removeLayer(marker);
      });
    }
    if (latLngs.length === 1) {
      map.setView(latLngs[0], 16);
    } else {
      map.fitBounds(latLngs);
    }
  }
});

/*
 * Distance Options – cirkler
 */
var currentCircle = null;
var selectedRadius = null;
function toggleCircle(radius) {
  selectedRadius = radius;
  if (!currentMarker) {
    alert("Vælg venligst en adresse eller klik på kortet først.");
    return;
  }
  let latLng = currentMarker.getLatLng();
  if (currentCircle && currentCircle.getRadius() === radius) {
    map.removeLayer(currentCircle);
    currentCircle = null;
    selectedRadius = null;
    // Fjern eventuel ladestander-lag (ikke brugt i Brand-version)
  } else {
    if (currentCircle) {
      map.removeLayer(currentCircle);
    }
    currentCircle = L.circle(latLng, {
      radius: radius,
      color: "blue",
      fillOpacity: 0.2
    }).addTo(map);
    // Ingen ladestander-lag i Brand-version
  }
}
document.getElementById("btn10").addEventListener("click", function() {
  selectedRadius = 10000;
  toggleCircle(10000);
});
document.getElementById("btn25").addEventListener("click", function() {
  selectedRadius = 25000;
  toggleCircle(25000);
});
document.getElementById("btn50").addEventListener("click", function() {
  selectedRadius = 50000;
  toggleCircle(50000);
});
document.getElementById("btn100").addEventListener("click", function() {
  selectedRadius = 100000;
  toggleCircle(100000);
});

/*
 * DOMContentLoaded
 */
document.addEventListener("DOMContentLoaded", function() {
  document.getElementById("search").focus();

  const planBtn = document.getElementById("planRouteBtn");
  if (planBtn) {
    planBtn.addEventListener("click", function() {
      planRouteORS();
    });
  }

  const clearRouteBtn = document.getElementById("clearRouteBtn");
  if (clearRouteBtn) {
    clearRouteBtn.addEventListener("click", function() {
      if (routeFromInput) routeFromInput.value = "";
      if (routeToInput)   routeToInput.value   = "";
      if (routeViaInput)  routeViaInput.value  = "";
      routeFromCoord = null;
      routeToCoord   = null;
      routeViaCoord  = null;

      if (routeFromList) {
        routeFromList.innerHTML = "";
        routeFromList.style.display = "none";
      }
      if (routeToList) {
        routeToList.innerHTML = "";
        routeToList.style.display = "none";
      }
      if (routeViaList) {
        routeViaList.innerHTML = "";
        routeViaList.style.display = "none";
      }

      const routeSummaryEl = document.getElementById("routeSummary");
      if (routeSummaryEl) {
        routeSummaryEl.textContent = "";
      }

      routeLayer.clearLayers();

      // Ryd kun markør, hvis vi IKKE er i "Behold markører"-tilstand
      if (!keepMarkersEnabled && currentMarker) {
        map.removeLayer(currentMarker);
        currentMarker = null;
      }
      resetCoordinateBox();
    });
  }

  // Deaktivér "Udland"-søgning hvis ORS-nøgle mangler
  if (foreignSearchToggle && (!ORS_API_KEY || ORS_API_KEY.includes("YOUR_ORS_API_KEY"))) {
    foreignSearchToggle.checked = false;
    foreignSearchToggle.disabled = true;
    foreignSearchToggle.title = "Udland-søgning kræver en gyldig OpenRouteService API-nøgle";
  }

  // Auto-opdater rute når profil/præference ændres – men kun hvis der allerede er en rute
  const routeProfileSel    = document.getElementById("routeProfile");
  const routePreferenceSel = document.getElementById("routePreference");

  function autoRecalculateRoute() {
    if (!routeLayer) return;
    const hasRoute = routeLayer.getLayers().length > 0;
    if (hasRoute) {
      planRouteORS();
    }
  }

  if (routeProfileSel) {
    routeProfileSel.addEventListener("change", autoRecalculateRoute);
  }
  if (routePreferenceSel) {
    routePreferenceSel.addEventListener("change", autoRecalculateRoute);
  }
});
