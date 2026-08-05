import math

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

# Find k for Review 4 solid curve
# It starts at 828, 20 and ends at 880, 28.7
# 28.7 = 460 - (460 - 20) * exp(-k * (880 - 828))
# (460 - 28.7) / 440 = exp(-k * 52)
# 431.3 / 440 = exp(-k * 52)
k = -math.log((460 - 28.7) / 440) / 52
print(f"k (Review 4 solid): {k}")

# Now generate dotted line from 880.0, 28.7 to 920.0 using same k
dotted = generate_curve(880.0, 28.7, k, 920.0, 30)
print(f"Dotted path:\n{dotted}")
