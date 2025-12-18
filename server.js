const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Safe fetch import
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- 1. HELPER FUNCTIONS ---
function getFlagEmoji(countryCode) {
    if (!countryCode) return "";
    const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

function formatDate(dateObj, timezone, format) {
    if (!dateObj) return "TBD";
    let locale = 'en-US';
    let options = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
    
    if (format === 'iso') { locale = 'en-CA'; options = { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }; }
    else if (format === 'us') { locale = 'en-US'; }
    else if (format === 'eu') { locale = 'en-GB'; }
    else if (format === 'long') { options = { timeZone: timezone, dateStyle: 'long' }; }

    try {
        return new Intl.DateTimeFormat(locale, options).format(dateObj);
    } catch (e) {
        return dateObj.toISOString().split('T')[0];
    }
}

function groupCandidates(candidates) {
    if (!candidates || candidates.length === 0) return [];
    candidates.sort((a, b) => a.date - b.date);
    const groups = [];
    let currentGroup = null;
    candidates.forEach(cand => {
        if (!currentGroup) {
            currentGroup = { date: cand.date, countries: [cand.country], isSuspicious: false };
        } else {
            if (cand.date.getTime() === currentGroup.date.getTime()) {
                if (!currentGroup.countries.includes(cand.country)) currentGroup.countries.push(cand.country);
            } else {
                groups.push(currentGroup);
                currentGroup = { date: cand.date, countries: [cand.country], isSuspicious: false };
            }
        }
    });
    if (currentGroup) groups.push(currentGroup);
    groups.sort((a, b) => a.date - b.date);
    groups.forEach(g => g.countries.sort());
    return groups;
}

async function handleStreamRequest(type, id, config) {
    if (!config || !config.apiKey) {
        return { streams: [{ title: "⚠️ Please configure API Key", url: "https://www.themoviedb.org/" }] };
    }
    const { apiKey, timezone, dateFormat } = config;

    let tmdbId = null;
    try {
        const findUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${apiKey}&external_source=imdb_id`;
        const findResp = await fetch(findUrl);
        const findData = await findResp.json();
        if (type === 'movie' && findData.movie_results?.length > 0) tmdbId = findData.movie_results[0].id;
        else if (type === 'series' && findData.tv_results?.length > 0) tmdbId = findData.tv_results[0].id;
        else return { streams: [] };
    } catch (e) {
        return { streams: [] };
    }

    let outputLines = [];
    try {
        if (type === 'movie') {
            const url = `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?api_key=${apiKey}`;
            const resp = await fetch(url);
            const data = await resp.json();
            let theatrical = [], digital = [];
            if (data.results) {
                data.results.forEach(ce => {
                    ce.release_dates.forEach(r => {
                        const d = new Date(r.release_date);
                        if (r.type === 3) theatrical.push({ date: d, country: ce.iso_3166_1 });
                        if (r.type === 4) digital.push({ date: d, country: ce.iso_3166_1 });
                    });
                });
            }
            const gTheat = groupCandidates(theatrical);
            const gDig = groupCandidates(digital);
            let finalTheat = gTheat[0] || null;
            let finalDig = [];

            if (gDig.length > 0) {
                if (finalTheat) {
                    for (let i = 0; i < gDig.length; i++) {
                        if (gDig[i].date < finalTheat.date) { gDig[i].isSuspicious = true; finalDig.push(gDig[i]); }
                        else { gDig[i].isSuspicious = false; finalDig.push(gDig[i]); break; }
                    }
                } else finalDig.push(gDig[0]);
            }

            if (finalTheat) outputLines.push(`Theatrical: ${formatDate(finalTheat.date, timezone, dateFormat)} (${finalTheat.countries.map(c=>getFlagEmoji(c)).join(" ")})`);
            else outputLines.push("Theatrical: TBD");

            if (finalDig.length > 0) {
                finalDig.forEach(g => {
                    const susp = g.isSuspicious ? " (Likely Untrue)" : "";
                    outputLines.push(`Digital: ${formatDate(g.date, timezone, dateFormat)} (${g.countries.map(c=>getFlagEmoji(c)).join(" ")})${susp}`);
                });
            } else outputLines.push("Digital: TBD");

        } else if (type === 'series') {
            const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}`;
            const resp = await fetch(url);
            const details = await resp.json();
            let targetDate = details.next_episode_to_air?.air_date || details.last_episode_to_air?.air_date;
            
            if (targetDate) {
                outputLines.push(`Air Date: ${formatDate(new Date(targetDate), timezone, dateFormat)} (${(details.origin_country||[]).map(c=>getFlagEmoji(c)).join(" ")})`);
            } else outputLines.push("Air Date: TBD");
        }
    } catch (err) {
        return { streams: [{ title: "⚠️ Error fetching dates", name: "Error" }] };
    }

    return {
        streams: [{
            name: "Release Date",
            title: outputLines.join("\n"),
            externalUrl: `https://www.themoviedb.org/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}` 
        }]
    };
}

// --- 2. EXPRESS SERVER SETUP ---
const app = express();
const port = process.env.PORT || 7000;

app.use(cors());

// BASE MANIFEST
const baseManifest = {
    id: "org.releasedatefinder",
    version: "1.0.0",
    name: "Release Date Finder",
    description: "Shows Theatrical and Digital release dates directly in your streams list.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

// A. Serve the Configure Page (Root URL)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'configure.html'));
});

// B. Handle /configure route (Fixes the 404 error)
// When Stremio says "Configure", it goes here. We just show the HTML again.
app.get('/:config/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'configure.html'));
});

// C. Handle Manifest Request (The Smart Manifest Fix)
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    
    // CLONE the manifest so we don't modify the global one
    const manifest = { ...baseManifest };

    // LOGIC: If 'config' is present in URL, user has configured it.
    // So we set configurationRequired = false to show "INSTALL" button.
    if (req.params.config) {
        manifest.behaviorHints = {
            configurable: true,
            configurationRequired: false 
        };
    } else {
        // No config yet, force configuration
        manifest.behaviorHints = {
            configurable: true,
            configurationRequired: true 
        };
    }
    
    res.send(manifest);
});

// D. Handle Stream Request
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let config = {};
    if (req.params.config) {
        try {
            const buffer = Buffer.from(req.params.config, 'base64');
            config = JSON.parse(buffer.toString('utf-8'));
        } catch (e) {
            console.error("Config parse error", e);
        }
    }
    const response = await handleStreamRequest(req.params.type, req.params.id, config);
    res.send(response);
});

app.listen(port, () => {
    console.log(`Add-on active on port ${port}`);
});
