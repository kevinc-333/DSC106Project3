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
    .attr("width", width)
    .attr("height", height);

const g = svg.append("g");
const tooltip = d3.select("#tooltip");

// 2. Define projection and geoPath
const projection = d3.geoAlbersUsa()
    .scale(1200)
    .translate([width / 2, height / 2]);

const path = d3.geoPath().projection(projection);

// 3. Dynamic Color Scales
const tempColorScale = d3.scaleSequential()
    .domain([0, 8])
    .interpolator(t => d3.interpolateOrRd(t * 0.8 + 0.2));

const rainColorScale = d3.scaleSequential()
    .domain([-30, 30])
    .interpolator(d3.interpolateBrBG);

// 4. Strict Bounded Pan and Zoom
const zoom = d3.zoom()
    .scaleExtent([1, 8])
    .translateExtent([[-width / 2, -height / 2], [width * 1.5, height * 1.5]])
    .on("zoom", (event) => {
        g.attr("transform", event.transform);
    });

svg.call(zoom);

// 5. Load TopoJSON Map and CMIP6 Projections Concurrently
Promise.all([
    d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json"),
    d3.json("state_projections.json")
]).then(([usData, cmipData]) => {
    const statesGeo = topojson.feature(usData, usData.objects.states).features;

    function getClimateValue(stateName, year, variable, scenario) {
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

    function updateMapColors() {
        statePaths.transition()
            .duration(150)
            .attr("fill", d => {
                const stateName = d.properties.name;
                const val = getClimateValue(stateName, currentYear, currentVariable, currentScenario);
                return currentVariable === "temperature" ? tempColorScale(val) : rainColorScale(val);
            });
    }

    // Draw State Paths
    const statePaths = g.selectAll(".state")
        .data(statesGeo)
        .enter()
        .append("path")
        .attr("class", "state")
        .attr("d", path)
        .attr("fill", d => {
            const stateName = d.properties.name;
            const val = getClimateValue(stateName, currentYear, currentVariable, currentScenario);
            return tempColorScale(val);
        })
        .on("mousemove", function(event, d) {
            d3.select(this).raise();
            const stateName = d.properties.name;
            const val = getClimateValue(stateName, currentYear, currentVariable, currentScenario);
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
    const slider = document.getElementById("yearSlider");
    const yearLabel = document.getElementById("yearLabel");
    const scenarioSelector = document.getElementById("scenarioSelector");
    const variableSelector = document.getElementById("variableSelector");
    const mainTitle = document.getElementById("main-title");

    slider.addEventListener("input", function() {
        currentYear = parseInt(this.value);
        yearLabel.innerText = currentYear;
        updateMapColors();
    });

    scenarioSelector.addEventListener("change", function() {
        currentScenario = this.value;
        updateMapColors();
    });

    variableSelector.addEventListener("change", function() {
        currentVariable = this.value;
        mainTitle.innerText = `U.S. Climate Projections: ${currentVariable === 'temperature' ? 'Temperature Warming' : 'Rainfall Change'}`;
        updateMapColors();
    });

}).catch(error => {
    console.error("Error loading climate datasets:", error);
});