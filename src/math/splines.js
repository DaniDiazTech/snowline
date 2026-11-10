/**
 * Curve helpers used across the game.
 *
 *  - Catmull-Rom: an interpolating spline that passes THROUGH its control
 *    points. We use it to turn sparse noise samples into a smooth road.
 *  - De Casteljau: evaluates a Bezier curve of any degree by repeated linear
 *    interpolation. We use it for the car silhouette and for coin arcs.
 *
 * Points are plain objects: { x, y }.
 */

/**
 * Uniform Catmull-Rom point between p1 and p2 (t in [0, 1]).
 * Same matrix form seen in class:
 *   P(t) = 0.5 * [ 2P1 + (-P0 + P2)t + (2P0 - 5P1 + 4P2 - P3)t^2 + (-P0 + 3P1 - 3P2 + P3)t^3 ]
 */
export function catmullRom(p0, p1, p2, p3, t) {
  return {
    x: catmullRomScalar(p0.x, p1.x, p2.x, p3.x, t),
    y: catmullRomScalar(p0.y, p1.y, p2.y, p3.y, t),
  };
}

/** Scalar uniform Catmull-Rom between b and c (t in [0, 1]). */
export function catmullRomScalar(a, b, c, d, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * b +
      (-a + c) * t +
      (2 * a - 5 * b + 4 * c - d) * t2 +
      (-a + 3 * b - 3 * c + d) * t3)
  );
}

/**
 * Point on a Bezier curve using De Casteljau's algorithm.
 * Works for any number of control points (linear, quadratic, cubic, ...).
 */
export function deCasteljau(controlPoints, t) {
  let points = controlPoints.map((p) => ({ x: p.x, y: p.y }));

  // Collapse the polygon one level at a time until a single point remains.
  while (points.length > 1) {
    const next = [];
    for (let i = 0; i < points.length - 1; i++) {
      next.push({
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      });
    }
    points = next;
  }
  return points[0];
}

/** Samples a Bezier curve into `segments + 1` evenly spaced (in t) points. */
export function sampleBezier(controlPoints, segments) {
  const result = [];
  for (let i = 0; i <= segments; i++) {
    result.push(deCasteljau(controlPoints, i / segments));
  }
  return result;
}

/**
 * Cubic Hermite interpolation between (0, p0) and (1, p1) with tangents m0, m1
 * (tangents already scaled to the unit interval). C1 continuous when chained.
 */
export function hermite(p0, m0, p1, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

/** Derivative d/dt of `hermite` (divide by the interval length to get d/dx). */
export function hermiteDerivative(p0, m0, p1, m1, t) {
  const t2 = t * t;
  return (6 * t2 - 6 * t) * p0 + (3 * t2 - 4 * t + 1) * m0 + (-6 * t2 + 6 * t) * p1 + (3 * t2 - 2 * t) * m1;
}
