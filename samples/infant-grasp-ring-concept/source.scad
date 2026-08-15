// Infant grasp-ring concept inspired by generic Montessori grasping toys.
// PROTOTYPE ONLY: not certified or validated for infant use.
// One fused body; no pellets, fasteners, detachable beads, or sharp corners.

outer_d = 90;
ring_d = 14;
hub_d = 22;
spoke_d = 12;
texture_d = 5;

$fn = 56;

module capsule_between(a, b, d) {
  hull() {
    translate(a) sphere(d = d);
    translate(b) sphere(d = d);
  }
}

module grasp_ring() {
  major_r = (outer_d - ring_d) / 2;

  union() {
    // Rounded outer loop, made from overlapping capsules for a single solid.
    for (angle = [0 : 15 : 345]) {
      next = angle + 15;
      capsule_between(
        [major_r*cos(angle), major_r*sin(angle), 0],
        [major_r*cos(next), major_r*sin(next), 0],
        ring_d
      );
    }

    // Three broad grasping spokes join into a rounded central palm pad.
    for (angle = [30, 150, 270])
      capsule_between(
        [0, 0, 0],
        [(major_r - 2)*cos(angle), (major_r - 2)*sin(angle), 0],
        spoke_d
      );

    sphere(d = hub_d);

    // Low-profile fused sensory bumps; intentionally larger than decorative dots.
    for (angle = [0 : 30 : 330])
      translate([
        major_r*cos(angle),
        major_r*sin(angle),
        ring_d*0.43
      ])
        scale([1.35, 1.35, 0.55]) sphere(d = texture_d);
  }
}

grasp_ring();
