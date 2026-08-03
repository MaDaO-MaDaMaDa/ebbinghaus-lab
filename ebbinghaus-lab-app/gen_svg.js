const fs = require('fs');

function getY(R) {
    return 460 - 440 * R;
}

function getX(t) {
    return 50 + 50 * t;
}

function generatePath(tStart, tEnd, tOrigin, k, steps = 50) {
    let path = "";
    for (let i = 0; i <= steps; i++) {
        let t = tStart + (tEnd - tStart) * (i / steps);
        let timeSinceReview = t - tOrigin;
        let R = Math.exp(-k * timeSinceReview);
        let x = getX(t);
        let y = getY(R);
        if (i === 0) {
            path += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
        } else {
            path += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
        }
    }
    return path;
}

const k0 = Math.log(3); // 1.1, drop to 1/3 at day 1
const k1 = Math.log(2) / 2; // 0.346, drop to 1/2 at day 3 (2 days later)
const k2 = -Math.log(0.7) / 4; // 0.089, drop to 70% at day 7 (4 days later)
const k3 = -Math.log(0.8) / 7; // 0.032, drop to 80% at day 14 (7 days later)
const k4 = 0.01;

// Solid curves (start at tOrigin, end at tEnd)
console.log('--- SOLID CURVES ---');
console.log('Curve 1:', generatePath(0, 1, 0, k0));
console.log('Curve 2:', generatePath(1, 3, 1, k1));
console.log('Curve 3:', generatePath(3, 7, 3, k2));
console.log('Curve 4:', generatePath(7, 14, 7, k3));
console.log('Solid 4 (Day 14 onwards):', generatePath(14, 16, 14, k4)); // Just a short tail for the last review

// Dotted curves (continuations without review)
// They start where the solid curve ended, and use the same tOrigin and k.
console.log('--- DOTTED CURVES ---');
console.log('Dotted 1 (Day 1 to 16):', generatePath(1, 16, 0, k0));
console.log('Dotted 2 (Day 3 to 16):', generatePath(3, 16, 1, k1));
console.log('Dotted 3 (Day 7 to 16):', generatePath(7, 16, 3, k2));
console.log('Dotted 4 (Day 14 to 16):', generatePath(14, 16, 7, k3));

