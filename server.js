const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
function getFlagEmoji(countryCode) {
    if (!countryCode) return "";
    const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}
function getOrdinalNum(n) {
    return n + (["st", "nd", "rd"][((n + 90) % 100 - 10) % 10 - 1] || "th");
}
function parseDateSafe(dateString) {
    if (!dateString) return null;
    const cleanDate = dateString.split('T')[0];
    const parts = cleanDate.split('-');
    if (parts.length !== 3) return null;
    return new Date(Number(parts[0]), parts[1] - 1, Number(parts[2]), 12, 0, 0);
}
function formatDateSafe(dateObj, formatStr) {
    if (!dateObj) return "TBD";
    const year = dateObj.getFullYear();
    const monthIndex = dateObj.getMonth();
    const day = dateObj.getDate();
    const mm = String(monthIndex + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    if (isNaN(year)) return "TBD";
    switch (formatStr) {
        case 'iso':
            return `${year}-${mm}-${dd}`;
        case 'us':
            return `${mm}/${dd}/${year}`;
        case 'eu':
            return `${dd}/${mm}/${year}`;
        case 'long':
        default:
            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const mName = monthNames[monthIndex];
            const dOrd = getOrdinalNum(day);
            const now = new Date();
            if (year !== now.getFullYear()) {
                return `${mName} ${dOrd}, ${year}`;
            }
            return `${mName} ${dOrd}`;
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
        return { streams: [{ title: "⚠️ Please configure API key", url: "https://www.themoviedb.org/" }] };
    }
    const { apiKey, dateFormat } = config;
    const cleanId = id.split(':')[0];
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
    let statusEmojis = [];
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
                        const d = parseDateSafe(r.release_date);
                        if (!d) return;
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
                        if (gDig[i].date < finalTheat.date) {
                            gDig[i].isSuspicious = true;
                            finalDig.push(gDig[i]);
                        } else {
                            gDig[i].isSuspicious = false;
                            finalDig.push(gDig[i]);
                            break;
                        }
                    }
                } else {
                    finalDig.push(gDig[0]);
                }
            }
            if (finalTheat) {
                const dateStr = formatDateSafe(finalTheat.date, dateFormat);
                const flags = finalTheat.countries.map(c => getFlagEmoji(c)).join("  ");
                outputLines.push(`Theaters: ${dateStr}    ${flags}`);
                statusEmojis.push(finalTheat.date < now ? "✅" : "❌");
            } else {
                outputLines.push("Theaters: TBD");
                statusEmojis.push("❌");
            }
            if (finalDig.length > 0) {
                finalDig.forEach(g => {
                    const dateStr = formatDateSafe(g.date, dateFormat);
                    const flags = g.countries.map(c => getFlagEmoji(c)).join("  ");
                    const susp = g.isSuspicious ? " (Likely Wrong)" : "";
                    outputLines.push(`Digital      : ${dateStr}    ${flags}${susp}`);
                    statusEmojis.push(g.date < now ? "✅" : "❌");
                });
            } else {
                outputLines.push("Digital      : TBD");
                statusEmojis.push("❌");
            }
        } else if (type === 'series') {
            const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}`;
            const resp = await fetch(url);
            const details = await resp.json();
            let targetDate = null;
            let labelText = "";
            let prefix = "Air Date:";
            if (details.next_episode_to_air) {
                targetDate = parseDateSafe(details.next_episode_to_air.air_date);
                const lastSeasonNum = details.last_episode_to_air ? details.last_episode_to_air.season_number : 0;
                const nextSeasonNum = details.next_episode_to_air.season_number;
                if (nextSeasonNum > lastSeasonNum) {
                    prefix = "Next SZN Air Date:";
                } else {
                    prefix = "Next EP Air Date:";
                }
            } else if (details.last_episode_to_air) {
                targetDate = parseDateSafe(details.last_episode_to_air.air_date);
                prefix = "Last Air Date:";
                try {
                    const lastSeasonNum = details.last_episode_to_air.season_number;
                    const seasonUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${lastSeasonNum}?api_key=${apiKey}`;
                    const seasonResp = await fetch(seasonUrl);
                    const seasonData = await seasonResp.json();
                    const airDates = new Set();
                    if(seasonData.episodes) seasonData.episodes.forEach(e => { if(e.air_date) airDates.add(e.air_date) });
                    if (airDates.size === 1) {
                        labelText = "(Last Season)";
                    } else {
                        labelText = "(Last Episode, Last Season)";
                    }
                } catch (e) {
                    labelText = "(Last Episode, Last Season)";
                }
            }
            if (targetDate) {
                const dateStr = formatDateSafe(targetDate, dateFormat);
                const flags = (details.origin_country || []).map(c => getFlagEmoji(c)).join("  ");
                outputLines.push(`${prefix} ${dateStr}    ${flags}`);
                if (labelText) outputLines.push(labelText);
                statusEmojis.push(targetDate < now ? "✅" : "❌");
            } else {
                outputLines.push("Air Date: TBD");
                statusEmojis.push("❌");
            }
        }
    } catch (err) {
        console.error(err);
        return { streams: [{ title: "⚠️ Error fetching dates", name: "Error" }] };
    }
    const emojiStack = statusEmojis.join("\n");
    return {
        streams: [{
            name: emojiStack,
            title: outputLines.join("\n"),
            externalUrl: `https://www.themoviedb.org/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}`
        }]
    };
}
const app = express();
const port = process.env.PORT || 7000;
app.use(cors());
const baseManifest = {
    id: "org.releasedatefinder",
    version: "1.0.0",
    name: "Release Date Finder",
    description: "Stremio add-on for fetching release dates of movies and TV shows.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'configure.html'));
});
app.get('/:config/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'configure.html'));
});
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
