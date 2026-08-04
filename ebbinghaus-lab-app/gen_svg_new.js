const fs = require('fs');

const X_START = 50;
const X_END = 850;
const Y_TOP = 20;
const Y_BOTTOM = 460;
const Y_RANGE = 440;
const DAYS = 16;
const X_PER_DAY = (750 - 50) / 14; // 50

function getY(retention) {
    return Y_BOTTOM - (retention * Y_RANGE / 100);
}

const reviews = [
    { day: 0, x: 50 },
    { day: 1, x: 100 },
    { day: 3, x: 200 },
    { day: 7, x: 400 },
    { day: 14, x: 750 }
];

// Determine retention rates right before review
const retentionTargets = [
    { elapsed: 1, target: 33.3 },   // at Day 1
    { elapsed: 2, target: 45.0 },   // at Day 3 (2 days since Day 1)
    { elapsed: 4, target: 65.0 },   // at Day 7 (4 days since Day 3)
    { elapsed: 7, target: 80.0 },   // at Day 14 (7 days since Day 7)
    { elapsed: 14, target: 90.0 }   // beyond Day 14
];

const kValues = retentionTargets.map(t => -Math.log(t.target / 100) / t.elapsed);

function generatePath(startX, endX, startDay, k, dotted) {
    let path = [];
    // Number of steps needs to be sufficient for a smooth curve
    // For dotted lines we also want enough points, but the dasharray handles the dots.
    const steps = Math.floor((endX - startX) / 2);
    const stepSize = (endX - startX) / steps;
    for (let i = 0; i <= steps; i++) {
        let x = startX + i * stepSize;
        let t = (x - (startDay * X_PER_DAY + X_START)) / X_PER_DAY;
        let r = 100 * Math.exp(-k * t);
        path.push(`L ${x.toFixed(1)} ${getY(r).toFixed(1)}`);
    }
    let d = path.join(' ');
    return d.replace('L', 'M');
}

let out = "";
out += "            <!-- Curve Continuations (Dotted - No Review) -->\n";
for (let i = 0; i < 4; i++) {
    // The dotted line continues the PREVIOUS solid curve (curve `i`).
    // So it starts at reviews[i+1].x, but its decay follows the formula of curve `i`.
    // It is just extending curve `i` beyond its review point.
    let startX = reviews[i+1].x;
    let endX = X_END;
    let startDay = reviews[i].day;
    let k = kValues[i];
    let d = generatePath(startX, endX, startDay, k, true);
    out += `            <path class="fade-in delay-fade-${i+1}" d="${d}" fill="none" stroke="#64748B" stroke-width="2" stroke-dasharray="6 6" stroke-linecap="round" />\n`;
}

out += "\n            <!-- Solid Curves -->\n            <!-- Curve 1 (Initial Learning) -->\n";
for (let i = 0; i < 5; i++) {
    let startX = reviews[i].x;
    let endX = i < 4 ? reviews[i+1].x : X_END;
    let startDay = reviews[i].day;
    let k = i < 5 ? kValues[i] : kValues[4];
    let d = generatePath(startX, endX, startDay, k, false);
    let delay = i === 0 ? '' : ` delay-${i}`;
    let grad = i === 0 ? '1' : (i < 4 ? i+1 : 4);
    if (i === 0) {
        out += `            <path class="draw-line" d="${d}" fill="none" stroke="url(#curveGrad1)" stroke-width="4" stroke-linecap="round" />\n`;
    } else {
        out += `\n            <!-- Review ${i} -->\n`;
        let color = ["", "#10B981", "#06B6D4", "#6366F1", "#EC4899"][i];
        
        // Find Y value where the PREVIOUS curve ended at this X.
        // The previous curve started at reviews[i-1].day, and ended at reviews[i].day.
        // Time elapsed = reviews[i].day - reviews[i-1].day
        let elapsed = reviews[i].day - reviews[i-1].day;
        let prevR = 100 * Math.exp(-kValues[i-1] * elapsed);
        let endY = getY(prevR).toFixed(1);

        out += `            <line class="fade-in delay-fade-${i}" x1="${startX}" y1="${endY}" x2="${startX}" y2="20" stroke="${color}" stroke-width="2" stroke-dasharray="4" />\n`;
        out += `            <circle class="fade-in delay-fade-${i} dot-animate" cx="${startX}" cy="20" r="5" fill="${color}" style="transform-origin: ${startX}px 20px" />\n`;
        out += `            <path class="draw-line${delay}" d="${d}" fill="none" stroke="url(#curveGrad${grad})" stroke-width="4" stroke-linecap="round" />\n`;
    }
}

fs.writeFileSync('svg_output.html', out);
console.log("Done");
