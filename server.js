const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Safe fetch import
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- 1. CONFIGURATION ---
const MANIFEST = {
    id: "org.releasedatefinder",
    version: "1.0.1",
    name: "Release Date Finder",
    description: "Shows Theatrical and Digital release dates directly in your streams list.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

// --- 2. HELPER FUNCTIONS ---
function getFlagEmoji(countryCode) {
    if (!countryCode) return "";
    const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

function formatDate(dateObj, timezone) {
    if (!dateObj) return "TBD";
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const dateYear = dateObj.getFullYear();
    
    // Logic: Short Month (MMM), Day. Hide Year if it matches Current Year.
    let options = { 
        timeZone: timezone, 
        month: 'short', 
        day: 'numeric' 
    };

    // Only add year if it is NOT the current year
    if (dateYear !== currentYear) {
        options.year = 'numeric';
    }

    try {
        return new Intl.DateTimeFormat('en-US', options).format(dateObj);
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

// --- 3. STREAM PROCESSING LOGIC ---
async function handleStreamRequest(type, id, config) {
    if (!config || !config.apiKey) {
        return { streams: [{ title: "⚠️ Please configure API Key", url: "https://www.themoviedb.org/" }] };
    }
    const { apiKey, timezone } = config;

    // FIX: TV Shows send IDs like 'tt12345:1:2'. We need just 'tt12345' for lookup.
    const cleanId = id.split(':')[0];

    // Resolve IDs
    let tmdbId = null;
    try {
        const findUrl = `https://api.themoviedb.org/3/find/${cleanId}?api_key=${apiKey}&external_source=imdb_id`;
        const findResp = await fetch(findUrl);
        const findData = await findResp.json();
        if (type === 'movie' && findData.movie_results?.length > 0) tmdbId = findData.movie_results[0].id;
        else if (type === 'series' && findData.tv_results?.length > 0) tmdbId = findData.tv_results[0].id;
        else return { streams: [] };
    } catch (e) {
        return { streams: [] };
    }

    let outputLines = [];
    let statusEmojis = []; // Stores ✅ or ❌
    const now = new Date();

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

            // --- THEATERS LINE ---
            if (finalTheat) {
                const dateStr = formatDate(finalTheat.date, timezone);
                const flags = finalTheat.countries.map(c => getFlagEmoji(c)).join(" ");
                outputLines.push(`Theaters: ${dateStr} (${flags})`);
                
                // Emoji Logic: Has it released yet?
                statusEmojis.push(finalTheat.date < now ? "✅" : "❌");
            } else {
                outputLines.push("Theaters: TBD");
                statusEmojis.push("❌");
            }

            // --- DIGITAL LINE ---
            // Added explicit 4 spaces as requested
            if (finalDig.length > 0) {
                finalDig.forEach(g => {
                    const dateStr = formatDate(g.date, timezone);
                    const flags = g.countries.map(c => getFlagEmoji(c)).join(" ");
                    const susp = g.isSuspicious ? " (Likely Untrue)" : "";
                    outputLines.push(`Digital    : ${dateStr} (${flags})${susp}`);
                    
                    statusEmojis.push(g.date < now ? "✅" : "❌");
                });
            } else {
                outputLines.push("Digital    : TBD");
                statusEmojis.push("❌");
            }

        } else if (type === 'series') {
            const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}`;
            const resp = await fetch(url);
            const details = await resp.json();
            let targetDateStr = details.next_episode_to_air?.air_date || details.last_episode_to_air?.air_date;
            
            if (targetDateStr) {
                const targetDate = new Date(targetDateStr);
                const dateStr = formatDate(targetDate, timezone);
                const flags = (details.origin_country || []).map(c => getFlagEmoji(c)).join(" ");
                outputLines.push(`Air Date: ${dateStr} (${flags})`);
                
                statusEmojis.push(targetDate < now ? "✅" : "❌");
            } else {
                outputLines.push("Air Date: TBD");
                statusEmojis.push("❌");
            }
        }
    } catch (err) {
        return { streams: [{ title: "⚠️ Error fetching dates", name: "Error" }] };
    }

    return {
        streams: [{
            // NAME: The left side. We join emojis with a newline to align vertically.
            name: statusEmojis.join("\n"),
            // TITLE: The right side. Information text.
            title: outputLines.join("\n"),
            externalUrl: `https://www.themoviedb.org/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}` 
        }]
    };
}

// --- 4. EXPRESS SERVER SETUP ---
const app = express();
const port = process.env.PORT || 7000;

app.use(cors());

// BASE MANIFEST
const baseManifest = {
    id: "org.releasedatefinder",
    version: "1.0.1",
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

// B. Handle /configure route
app.get('/:config/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'configure.html'));
});

// C. Handle Manifest Request
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const manifest = { ...baseManifest };
    if (req.params.config) {
        manifest.behaviorHints = { configurable: true, configurationRequired: false };
    } else {
        manifest.behaviorHints = { configurable: true, configurationRequired: true };
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
