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

# Find k4 for Review 3 solid curve
# It starts at 464, 20 and ends at 828, 184.1
# 184.1 = 460 - (460 - 20) * exp(-k4 * (828 - 464))
# (460 - 184.1) / 440 = exp(-k4 * 364)
# 275.9 / 440 = exp(-k4 * 364)
# ln(0.627) = -k4 * 364
k4 = -math.log((460 - 184.1) / 440) / (828 - 464)
print(f"k4 (Review 3 solid): {k4}")

# Now generate dotted line from 828, 184.1 to 920.0 using same k4
dotted = generate_curve(828.0, 184.1, k4, 920.0, 30)
print(f"Dotted 4 path:\n{dotted}")
