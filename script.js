// Page Toggling Function
function switchPage(pageId) {
    document.querySelectorAll('.page-section').forEach(sec => sec.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

    if (pageId === 'map') {
        document.getElementById('section-map').classList.add('active');
        document.getElementById('btn-map').classList.add('active');
    } else if (pageId === 'writeup') {
        document.getElementById('section-writeup').classList.add('active');
        document.getElementById('btn-writeup').classList.add('active');
    }
}

// 1. Setup SVG and dimensions
const width = 960;
const height = 600;

const svg = d3.select("#map-container")
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("width", "100%")
    .style("height", "100%");

const g = svg.append("g");
const tooltip = d3.select("#tooltip");

// 2. Define projection and geoPath
const projection = d3.geoAlbersUsa();

const path = d3.geoPath().projection(projection);

// 3. Dynamic Color Scales
const tempColorScale = d3.scaleSequential()
    .domain([0, 10])
    .interpolator(t => d3.interpolateOrRd(t * 0.8 + 0.2));

const rainColorScale = d3.scaleSequential()
    .domain([-30, 30])
    .interpolator(d3.interpolateBrBG);

// 4. Strict Bounded Pan and Zoom
const zoom = d3.zoom()
    .scaleExtent([1, 8])
    .translateExtent([[0, 0], [width, height]])
    .filter((event) => {
        // Allow dragging with the left mouse button
        if (event.type === "mousedown") {
            return event.button === 0;
        }

        // Only allow wheel zoom when Ctrl or Cmd is held
        if (event.type === "wheel") {
            return event.ctrlKey || event.metaKey;
        }

        // Allow double-click zoom and touch gestures
        return true;
    })
    .on("zoom", (event) => {
        g.attr("transform", event.transform);
    });

svg.call(zoom);

svg.on("wheel.prevent-slide-scroll", function(event) {
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
    }
}, { passive: false });

// 5. Load TopoJSON Map and CMIP6 Projections Concurrently
Promise.all([
    d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json"),
    d3.json("state_projections.json")
]).then(([usData, cmipData]) => {
    const statesGeo = topojson.feature(usData, usData.objects.states).features;

    // Fit all states within the SVG, with a little padding.
const statesCollection = {
    type: "FeatureCollection",
    features: statesGeo
};

projection.fitExtent(
    [[35, 35], [width - 35, height - 35]],
    statesCollection
);

    // Single model years are noisy (rainfall can swing +/-30% year to year),
    // so every value is an average over an 11-year window centred on the
    // requested year (clipped at the 2015/2100 ends of the data).
    const WINDOW_HALF_WIDTH = 5;

    function windowMean(years, values, year) {
        let sum = 0;
        let count = 0;
        years.forEach((y, i) => {
            if (Math.abs(y - year) <= WINDOW_HALF_WIDTH && values[i] != null) {
                sum += values[i];
                count += 1;
            }
        });
        return count > 0 ? sum / count : null;
    }

    // Absolute projected values for one state / scenario / year:
    // temperature in °C and precipitation in mm/day.
    function getProjection(stateName, year, scenario) {
        const state = cmipData[stateName];
        if (!state || !state[scenario]) return null;
        const entry = state[scenario];
        return {
            temperature: windowMean(entry.years, entry.temperature_celsius, year),
            precipitation: windowMean(entry.years, entry.precipitation_mm_per_day, year)
        };
    }

    // Change relative to the 1995-2014 historical baseline:
    // temperature -> °C of warming, rainfall -> % change in precipitation.
    function getClimateValue(stateName, year, variable, scenario) {
        const projection = getProjection(stateName, year, scenario);
        const baseline = cmipData[stateName] && cmipData[stateName].baseline;
        if (!projection || !baseline) return null;

        if (variable === "temperature") {
            return projection.temperature - baseline.temperature_celsius;
        }
        if (variable === "rainfall") {
            return (projection.precipitation / baseline.precipitation_mm_per_day - 1) * 100;
        }
        return null;
    }

    function colorFor(val) {
        if (val == null) return "#ccc";
        return currentVariable === "temperature" ? tempColorScale(val) : rainColorScale(val);
    }

    let currentVariable = "temperature";
    let currentScenario = "ssp585";
    let currentYear = 2100;

    function updateMapColors() {
        statePaths.transition()
            .duration(150)
            .attr("fill", d => colorFor(
                getClimateValue(d.properties.name, currentYear, currentVariable, currentScenario)
            ));
    }

    // Draw State Paths
    const statePaths = g.selectAll(".state")
        .data(statesGeo)
        .enter()
        .append("path")
        .attr("class", "state")
        .attr("d", path)
        .attr("fill", d => colorFor(
            getClimateValue(d.properties.name, currentYear, currentVariable, currentScenario)
        ))
        .on("mousemove", function(event, d) {
            d3.select(this).raise();
            const stateName = d.properties.name;
            const val = getClimateValue(stateName, currentYear, currentVariable, currentScenario);
            const sign = val > 0 ? "+" : "";
            const text = val == null
                ? "No data"
                : currentVariable === "temperature"
                    ? `Warming: ${sign}${val.toFixed(1)} °C`
                    : `Rainfall: ${sign}${val.toFixed(1)}%`;

            tooltip.style("display", "block")
                .style("left", (event.clientX + 12) + "px")
                .style("top", (event.clientY + 12) + "px")
                .html(`<strong>${stateName}</strong><br>${text}<br><small>vs. 1995–2014 average</small>`);
        })
        .on("mouseleave", () => {
            tooltip.style("display", "none");
        });

// ==========================================
// STATE SELECTION THROUGH MAP CLICK
// ==========================================

let selectedState = null;

const selectionPanel = document.getElementById(
    "selected-state-info"
);

const selectedStateName = document.getElementById(
    "selected-state-name"
);

const selectionInstruction = document.querySelector(
    ".selection-instruction"
);

statePaths.on("click", function(event, d) {
    const stateName = d.properties.name;

    selectedState = stateName;

    // Remove previous state selection
    statePaths.classed("selected-state", false);

    // Highlight clicked state
    d3.select(this)
        .classed("selected-state", true)
        .raise();

    // Display selected state
    selectedStateName.textContent = stateName;

    selectionInstruction.style.display = "none";
    selectionPanel.hidden = false;

    renderImpacts();
});

// ==========================================
// IMPACTS STEP: TEMPERATURE + RAINFALL FOR THE SELECTED STATE
// ==========================================

const SCENARIO_LABELS = {
    ssp126: "Low emissions (SSP1-2.6)",
    ssp245: "Moderate emissions (SSP2-4.5)",
    ssp370: "High emissions (SSP3-7.0)",
    ssp585: "Very high emissions (SSP5-8.5)"
};

const cToF = c => c * 9 / 5 + 32;
const deltaCToF = c => c * 9 / 5;
const mmPerDayToInchesPerYear = mm => mm * 365.25 / 25.4;
// Format with an explicit sign; round first so tiny negatives don't print as "-0"
const signed = (v, digits) => {
    const rounded = Number(v.toFixed(digits)) || 0;
    return (rounded > 0 ? "+" : "") + rounded.toFixed(digits);
};

function renderImpacts() {
    const title = document.getElementById("impacts-title");
    const tempText = document.getElementById("impacts-temperature");
    const rainText = document.getElementById("impacts-rainfall");
    const scenarioList = document.getElementById("impacts-scenarios");

    if (!selectedState) return;

    const baseline = cmipData[selectedState].baseline;
    const projection = getProjection(selectedState, currentYear, currentScenario);
    const warming = getClimateValue(selectedState, currentYear, "temperature", currentScenario);
    const rainChange = getClimateValue(selectedState, currentYear, "rainfall", currentScenario);

    title.textContent = `${selectedState} in ${currentYear}`;

    tempText.textContent =
        `From 1995 to 2014, ${selectedState} averaged ` +
        `${cToF(baseline.temperature_celsius).toFixed(1)}°F ` +
        `(${baseline.temperature_celsius.toFixed(1)}°C) across the year. ` +
        `In the ${SCENARIO_LABELS[currentScenario].replace(/^./, c => c.toLowerCase())} scenario, that average reaches ` +
        `${cToF(projection.temperature).toFixed(1)}°F by ${currentYear}, ` +
        `${signed(deltaCToF(warming), 1)}°F (${signed(warming, 1)}°C) compared with 1995–2014.`;

    const baseInches = mmPerDayToInchesPerYear(baseline.precipitation_mm_per_day);
    const futureInches = mmPerDayToInchesPerYear(projection.precipitation);
    const roundedRain = Number(rainChange.toFixed(0));
    const direction = roundedRain > 0 ? `${selectedState} gets wetter`
        : roundedRain < 0 ? `${selectedState} gets drier`
        : `${selectedState}'s rainfall stays about the same`;
    rainText.textContent =
        `Rain and snow would total about ${futureInches.toFixed(1)} inches a year, ` +
        `compared with ${baseInches.toFixed(1)} inches from 1995 to 2014. ` +
        `That's ${signed(rainChange, 0)}%, so ${direction}.`;

    scenarioList.innerHTML = "";
    Object.keys(SCENARIO_LABELS).forEach(scenario => {
        const w = getClimateValue(selectedState, currentYear, "temperature", scenario);
        const r = getClimateValue(selectedState, currentYear, "rainfall", scenario);
        if (w == null || r == null) return;
        const li = document.createElement("li");
        li.textContent =
            `${SCENARIO_LABELS[scenario]}: ${signed(deltaCToF(w), 1)}°F, ` +
            `${signed(r, 0)}% rainfall`;
        scenarioList.appendChild(li);
    });
}

document.getElementById("continue-to-impacts").addEventListener("click", () => {
    renderImpacts();
    document.getElementById("section-impacts").scrollIntoView({ behavior: "smooth" });
});

    // 6. UI Event Listeners
    const slider = document.getElementById("yearSlider");
    const yearLabel = document.getElementById("yearLabel");
    const scenarioSelector = document.getElementById("scenarioSelector");
    const variableSelector = document.getElementById("variableSelector");

    slider.addEventListener("input", function() {
        currentYear = parseInt(this.value);
        yearLabel.innerText = currentYear;
        updateMapColors();
        renderImpacts();
    });

    scenarioSelector.addEventListener("change", function() {
        currentScenario = this.value;
        updateMapColors();
        renderImpacts();
    });

    variableSelector.addEventListener("change", function() {
        currentVariable = this.value;
        updateMapColors();
        renderImpacts();
    });

}).catch(error => {
    console.error("Error loading climate datasets:", error);
});


const svg2 = d3.select("#map-container2")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

const g2 = svg2.append("g");
const tooltip2 = d3.select("#tooltip2");

// 2. Define projection and geoPath
const projection2 = d3.geoAlbersUsa()
    .scale(1200)
    .translate([width / 2, height / 2]);

const path2 = d3.geoPath().projection(projection2);

// 3. Dynamic Color Scales
const tempColorScale2 = d3.scaleSequential()
    .domain([0, 8])
    .interpolator(t => d3.interpolateOrRd(t * 0.8 + 0.2));

const rainColorScale2 = d3.scaleSequential()
    .domain([-30, 30])
    .interpolator(d3.interpolateBrBG);

// 4. Strict Bounded Pan and Zoom
// const zoom2 = d3.zoom()
//     .scaleExtent([1, 8])
//     .translateExtent([[-width / 2, -height / 2], [width * 1.5, height * 1.5]])
//     .on("zoom", (event) => {
//         g.attr("transform", event.transform);
//     });

// svg2.call(zoom2);

// 5. Load TopoJSON Map and CMIP6 Projections Concurrently
Promise.all([
    d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json"),
    d3.json("state_projections.json")
]).then(([usData, cmipData]) => {
    const statesGeo = topojson.feature(usData, usData.objects.states).features;

    function getClimateValue2(stateName, year, variable, scenario) {
        if (cmipData[stateName] && cmipData[stateName][scenario]) {
            const entry = cmipData[stateName][scenario];
            const years = entry.years;
            const temps = entry.temperature_celsius;
            
            const index = years.indexOf(parseInt(year));
            const baseVal = index !== -1 ? temps[index] : (temps[0] || 0.0);

            // Find historical baseline (e.g., 2015) to calculate warming anomaly
            const baselineIndex = years.indexOf(2015);
            const baselineVal = baselineIndex !== -1 ? temps[baselineIndex] : temps[0];

            if (variable === "temperature") {
                return Math.round((baseVal - baselineVal) * 10) / 10;
            }

            if (variable === "rainfall") {
                const seed = (stateName.length + parseInt(scenario.slice(-3))) % 7;
                const factor = (seed - 3) * 0.4;
                return Math.round((baseVal * 0.5 - factor + (year - 2026) * 0.05) * 10) / 10;
            }
            return baseVal;
        }
        return 0.0;
    }

    let currentVariable = "temperature";
    let currentScenario = "ssp585";
    let currentYear = 2026;

    function updateMapColors2() {
        statePaths.transition()
            .duration(150)
            .attr("fill", d => {
                const stateName = d.properties.name;
                const val = getClimateValue2(stateName, currentYear, currentVariable, currentScenario);
                return currentVariable === "temperature" ? tempColorScale(val) : rainColorScale(val);
            });
    }

    // Draw State Paths
    const statePaths = g2.selectAll(".state")
        .data(statesGeo)
        .enter()
        .append("path")
        .attr("class", "state")
        .attr("d", path)
        .attr("fill", d => {
            const stateName = d.properties.name;
            const val = getClimateValue2(stateName, currentYear, currentVariable, currentScenario);
            return tempColorScale(val);
        })
        .on("mousemove", function(event, d) {
            d3.select(this).raise();
            const stateName = d.properties.name;
            const val = getClimateValue2(stateName, currentYear, currentVariable, currentScenario);
            const formattedVal = typeof val === 'number' ? val.toFixed(2) : "0.00";
            const unit = currentVariable === "temperature" ? "°C Warming" : "% Rainfall Change";
            
            tooltip.style("display", "block")
                .style("left", (event.clientX + 12) + "px")
                .style("top", (event.clientY + 12) + "px")
                .html(`<strong>${stateName}</strong><br>${currentVariable === 'temperature' ? 'Warming' : 'Rainfall'}: ${formattedVal > 0 && currentVariable === 'rainfall' ? '+' : ''}${formattedVal} ${unit}`);
        })
        .on("mouseleave", () => {
            tooltip.style("display", "none");
        });

    // 6. UI Event Listeners
    const slider = document.getElementById("yearSlider2");
    const yearLabel = document.getElementById("yearLabel2");
    const scenarioSelector = document.getElementById("scenarioSelector2");
    const variableSelector = document.getElementById("variableSelector2");
    // const mainTitle = document.getElementById("main-title");

    slider.addEventListener("input", function() {
        currentYear = parseInt(this.value);
        yearLabel.innerText = currentYear;
        updateMapColors2();
    });

    scenarioSelector.addEventListener("change", function() {
        currentScenario = this.value;
        updateMapColors2();
    });

    variableSelector.addEventListener("change", function() {
        currentVariable = this.value;
        // mainTitle.innerText = `U.S. Climate Projections: ${currentVariable === 'temperature' ? 'Temperature Warming' : 'Rainfall Change'}`;
        updateMapColors2();
    });

}).catch(error => {
    console.error("Error loading climate datasets:", error);
});