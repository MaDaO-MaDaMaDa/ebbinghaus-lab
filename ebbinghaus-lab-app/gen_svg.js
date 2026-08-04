const fs = require('fs');

function getY(R) {
    return 460 - 440 * R; // 20 is 100%, 460 is 0%
}

function getX(t) {
    return 50 + 50 * t; // 50 is day 0, 850 is day 16
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

// Adjusted k values for distinct asymptotes and visually pleasing semi-logarithmic shape
const k0 = 0.9;   // Day 1: exp(-0.9) = 40.6%. At day 16: exp(-14.4) ~ 0%
const k1 = 0.18;  // Day 3 (t-1=2): exp(-0.36) = 69.7%. At day 16 (t-1=15): exp(-2.7) = 6.7%
const k2 = 0.06;  // Day 7 (t-3=4): exp(-0.24) = 78.6%. At day 16 (t-3=13): exp(-0.78) = 45.8%
const k3 = 0.02;  // Day 14 (t-7=7): exp(-0.14) = 86.9%. At day 16 (t-7=9): exp(-0.18) = 83.5%
const k4 = 0.005; 

console.log('--- SOLID CURVES ---');
console.log('Curve 1:', generatePath(0, 1, 0, k0));
console.log('Curve 2:', generatePath(1, 3, 1, k1));
console.log('Curve 3:', generatePath(3, 7, 3, k2));
console.log('Curve 4:', generatePath(7, 14, 7, k3));
console.log('Solid 4 (Day 14 onwards):', generatePath(14, 16, 14, k4));

console.log('--- DOTTED CURVES ---');
console.log('Dotted 1 (Day 1 to 16):', generatePath(1, 16, 0, k0, 100));
console.log('Dotted 2 (Day 3 to 16):', generatePath(3, 16, 1, k1, 100));
console.log('Dotted 3 (Day 7 to 16):', generatePath(7, 16, 3, k2, 100));
console.log('Dotted 4 (Day 14 to 16):', generatePath(14, 16, 7, k3, 50));
