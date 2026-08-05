import math

def get_k(x1, y1, x2, y2):
    # y = 460 - (460 - y1) * exp(-k * (x - x1))
    # y2 = 460 - (460 - y1) * exp(-k * (x2 - x1))
    # (460 - y2) / (460 - y1) = exp(-k * (x2 - x1))
    val = (460 - y2) / (460 - y1)
    k = -math.log(val) / (x2 - x1)
    return k

def generate_curve(x_start, y_start, k, x_end, num_points):
    points = []
    step = (x_end - x_start) / num_points
    for i in range(num_points + 1):
        x = x_start + i * step
        y = 460 - (460 - y_start) * math.exp(-k * (x - x_start))
        points.append(f"L {x:.1f} {y:.1f}")
    
    # replace first L with M
    points[0] = points[0].replace("L", "M")
    return " ".join(points)

X_END = 890.0

curves = [
    {"name": "delay-fade-1", "x1": 100.0, "y1": 20.0, "x2": 152.0, "y2": 298.1},
    {"name": "delay-fade-2", "x1": 152.0, "y1": 20.0, "x2": 256.0, "y2": 211.5},
    {"name": "delay-fade-3", "x1": 256.0, "y1": 20.0, "x2": 464.0, "y2": 165.1},
    {"name": "delay-fade-4", "x1": 464.0, "y1": 20.0, "x2": 828.0, "y2": 184.1},
    {"name": "delay-fade-5", "x1": 828.0, "y1": 20.0, "x2": 880.0, "y2": 28.7},
]

for c in curves:
    k = get_k(c["x1"], c["y1"], c["x2"], c["y2"])
    path = generate_curve(c["x2"], c["y2"], k, X_END, 40) # 40 points for smoothness
    print(f'<!-- {c["name"]} -->')
    print(f'<path class="fade-in {c["name"]}" d="{path}" fill="none" stroke="#64748B" stroke-width="2" stroke-dasharray="6 6" stroke-linecap="round" />\n')

