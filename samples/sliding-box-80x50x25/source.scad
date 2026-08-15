// 80 x 50 x 25 mm sliding-lid box
// Units: mm. view_mode: 0=assembly, 1=body, 2=lid, 3=print layout.
view_mode = 0;

outer_x = 80;
outer_y = 50;
outer_z = 25;
wall = 2;
corner_r = 4;
clearance = 0.30;
lid_t = 2;
groove_h = 2.4;
groove_depth = 1.2;

$fn = 64;

module rounded_rect_2d(x, y, r) {
  offset(r = r) square([x - 2*r, y - 2*r], center = true);
}

module rounded_prism(x, y, z, r) {
  linear_extrude(height = z) rounded_rect_2d(x, y, r);
}

module body() {
  difference() {
    translate([outer_x/2, outer_y/2, 0])
      rounded_prism(outer_x, outer_y, outer_z, corner_r);

    // Main cavity, open through the top.
    translate([outer_x/2, outer_y/2, wall])
      rounded_prism(
        outer_x - 2*wall,
        outer_y - 2*wall,
        outer_z,
        max(corner_r - wall, 0.5)
      );

    // Matching side grooves; open at the front so the lid slides in along X.
    for (y = [wall - groove_depth/2, outer_y - wall + groove_depth/2])
      translate([-0.1, y - groove_depth/2, outer_z - groove_h - 0.8])
        cube([outer_x + 0.2, groove_depth, groove_h]);
  }
}

module lid() {
  lid_y = outer_y - 2*wall - 2*clearance;
  tongue_y = lid_y + 2*(groove_depth - clearance);

  union() {
    // Top panel.
    translate([clearance, 0, 0])
      cube([outer_x - 2*clearance, lid_y, lid_t]);

    // Thin tongues engage the grooves in both long side walls.
    translate([clearance, -(tongue_y - lid_y)/2, 0.35])
      cube([outer_x - 2*clearance, tongue_y, groove_h - 2*clearance]);

    // Small pull tab at the exposed end.
    translate([outer_x - 8, lid_y/2 - 7, lid_t])
      linear_extrude(height = 1.4)
        offset(r = 2) square([6, 10], center = true);
  }
}

if (view_mode == 1) {
  body();
} else if (view_mode == 2) {
  lid();
} else if (view_mode == 3) {
  body();
  translate([0, outer_y + 8, 0]) lid();
} else {
  color("DeepSkyBlue") body();
  // Partially open assembly view for visual inspection.
  color([1.0, 0.55, 0.12, 0.92])
    translate([18, wall + clearance, outer_z - groove_h - 0.45]) lid();
}
