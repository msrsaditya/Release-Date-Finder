const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fs = require('fs');
const path = require('path');

// Safe fetch import for all Node environments
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// 1. Initialize the Add-on Builder
const builder = new addonBuilder({
    id: "org.releasedatefinder",
    version: "1.0.0",
    name: "Release Date Finder",
    description: "Shows Theatrical and Digital release dates directly in your streams list.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"], 
    catalogs: []
});

// --- HELPER: Country Code to Flag Emoji ---
function getFlagEmoji(countryCode) {
    if (!countryCode) return "";
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

// --- HELPER: Date Formatter ---
function formatDate(dateObj, timezone, format) {
    if (!dateObj) return "TBD";
    let locale = 'en-CA';
    let options = {
        timeZone: timezone === 'UTC' ? 'UTC' : timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    };

    if (format === 'iso') locale = 'en-CA';
    else if (format === 'us') locale = 'en-US';
    else if (format === 'eu') locale = 'en-GB';
    else if (format === 'long') {
        locale = 'en-US';
        options = { timeZone: timezone, dateStyle: 'long' };
    }
    
    try {
        return new Intl.DateTimeFormat(locale, options).format(dateObj);
    } catch (e) {
        return dateObj.toISOString().split('T')[0]; // Fallback
    }
}

// --- CORE LOGIC: Group Candidates ---
function groupCandidates(candidates) {
    if (!candidates || candidates.length === 0) return [];
    candidates.sort((a, b) => a.date - b.date);
    const groups = [];
    let currentGroup = null;
    candidates.forEach(cand => {
        if (!currentGroup) {
            currentGroup = {
                date: cand.date,
                countries: [cand.country],
                isSuspicious: false
            };
        } else {
            if (cand.date.getTime() === currentGroup.date.getTime()) {
                if (!currentGroup.countries.includes(cand.country)) {
                    currentGroup.countries.push(cand.country);
                }
            } else {
                groups.push(currentGroup);
                currentGroup = {
                    date: cand.date,
                    countries: [cand.country],
                    isSuspicious: false
                };
            }
        }
    });
    if (currentGroup) groups.push(currentGroup);
    groups.sort((a, b) => a.date - b.date);
    groups.forEach(g => g.countries.sort());
    return groups;
}

// --- STREAM HANDLER ---
builder.defineStreamHandler(async ({ type, id, config }) => {
    // 1. Parse Config
    if (!config || !config.apiKey) {
        return { streams: [{ title: "⚠️ Please configure API Key", url: "https://github.com" }] };
    }
    const { apiKey, timezone, dateFormat } = config;
    
    // 2. Resolve IMDB ID (tt...) to TMDB ID
    let tmdbId = null;
    try {
        const findUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${apiKey}&external_source=imdb_id`;
        const findResp = await fetch(findUrl);
        const findData = await findResp.json();
        
        if (type === 'movie' && findData.movie_results?.length > 0) {
            tmdbId = findData.movie_results[0].id;
        } else if (type === 'series' && findData.tv_results?.length > 0) {
            tmdbId = findData.tv_results[0].id;
        } else {
            return { streams: [] };
        }
    } catch (e) {
        console.error("ID Lookup Failed", e);
        return { streams: [] };
    }

    // 3. Process Logic based on Type
    let outputLines = [];

    try {
        if (type === 'movie') {
            const url = `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?api_key=${apiKey}`;
            const resp = await fetch(url);
            const data = await resp.json();

            let theatricalCandidates = [];
            let digitalCandidates = [];

            if (data.results) {
                data.results.forEach(countryEntry => {
                    const regionCode = countryEntry.iso_3166_1;
                    countryEntry.release_dates.forEach(release => {
                        const d = new Date(release.release_date);
                        const cand = { date: d, country: regionCode };
                        if (release.type === 3) theatricalCandidates.push(cand);
                        if (release.type === 4) digitalCandidates.push(cand);
                    });
                });
            }

            const groupedTheat = groupCandidates(theatricalCandidates);
            const groupedDig = groupCandidates(digitalCandidates);
            
            let finalTheatrical = groupedTheat.length > 0 ? groupedTheat[0] : null;
            let finalDigitals = [];

            if (groupedDig.length > 0) {
                if (finalTheatrical) {
                    const tDate = finalTheatrical.date;
                    for (let i = 0; i < groupedDig.length; i++) {
                        const group = groupedDig[i];
                        if (group.date < tDate) {
                            group.isSuspicious = true;
                            finalDigitals.push(group);
                        } else {
                            group.isSuspicious = false;
                            finalDigitals.push(group);
                            break; 
                        }
                    }
                } else {
                    finalDigitals.push(groupedDig[0]);
                }
            }

            if (finalTheatrical) {
                const flags = finalTheatrical.countries.map(c => getFlagEmoji(c)).join(" ");
                const dateStr = formatDate(finalTheatrical.date, timezone, dateFormat);
                outputLines.push(`Theatrical: ${dateStr} (${flags})`);
            } else {
                outputLines.push("Theatrical: TBD");
            }

            if (finalDigitals.length > 0) {
                finalDigitals.forEach(g => {
                    const flags = g.countries.map(c => getFlagEmoji(c)).join(" ");
                    const dateStr = formatDate(g.date, timezone, dateFormat);
                    const susp = g.isSuspicious ? " (Likely Untrue)" : "";
                    outputLines.push(`Digital: ${dateStr} (${flags})${susp}`);
                });
            } else {
                outputLines.push("Digital: TBD");
            }

        } else if (type === 'series') {
            const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}`;
            const resp = await fetch(url);
            const details = await resp.json();

            let targetDate = null;
            let labelText = "";

            if (details.next_episode_to_air) {
                targetDate = details.next_episode_to_air.air_date;
            } else if (details.last_episode_to_air) {
                targetDate = details.last_episode_to_air.air_date;
                try {
                    const lastSeasonNum = details.last_episode_to_air.season_number;
                    const sUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${lastSeasonNum}?api_key=${apiKey}`;
                    const sResp = await fetch(sUrl);
                    const sData = await sResp.json();
                    const airDates = new Set();
                    if(sData.episodes) sData.episodes.forEach(e => { if(e.air_date) airDates.add(e.air_date) });
                    
                    if (airDates.size === 1) labelText = "Last Season";
                    else labelText = "Last Episode, Last Season";
                } catch(e) {
                    labelText = "Last Episode, Last Season";
                }
            }

            if (targetDate) {
                const d = new Date(targetDate);
                const dateStr = formatDate(d, timezone, dateFormat);
                const flags = (details.origin_country || []).map(c => getFlagEmoji(c)).join(" ");
                outputLines.push(`Air Date: ${dateStr} (${flags})`);
                if (labelText) outputLines.push(labelText);
            } else {
                outputLines.push("Air Date: TBD");
            }
        }
    } catch (err) {
        console.error("Processing Error:", err);
        return { streams: [{ title: "⚠️ Error fetching dates", name: "Error" }] };
    }

    return {
        streams: [{
            name: "Release Date",
            title: outputLines.join("\n"),
            externalUrl: `https://www.themoviedb.org/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}` 
        }]
    };
});

// --- SERVER SETUP (THE FIX) ---
// We read your HTML file and pass it to the official Stremio SDK server.
// This guarantees that all Stremio routes (like /manifest.json) work perfectly.

const landingHTML = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8');

serveHTTP(builder.getInterface(), {
    port: process.env.PORT || 7000,
    landing: landingHTML 
});
