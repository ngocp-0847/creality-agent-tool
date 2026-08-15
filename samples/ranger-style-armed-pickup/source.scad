// Generic off-road pickup inspired by modern Ranger-class trucks.
// Not an exact Ford replica; no logos or trademark-specific grille.
// mode: 0=assembly, 1=body, 2=wheel, 3=turret, 4=print layout
mode = 0;

scale_len = 150;
body_w = 68;
ground_z = 22;
wheel_d = 34;
wheel_w = 13;
axle_d = 5;
fit_clearance = 0.35;

$fn = 48;

module rounded_box(size=[10,10,10], r=2) {
  x=size[0]; y=size[1]; z=size[2];
  hull()
    for (ix=[r, x-r], iy=[r, y-r])
      translate([ix,iy,r]) cylinder(h=max(z-2*r,0.1), r=r);
}

module wheel() {
  difference() {
    rotate([90,0,0]) cylinder(h=wheel_w, d=wheel_d, center=true);
    rotate([90,0,0]) cylinder(h=wheel_w+2, d=axle_d+2*fit_clearance, center=true);
    // Chunky tread cuts.
    for (a=[0:30:330])
      rotate([0,a,0]) translate([wheel_d/2-1,0,0])
        cube([4,wheel_w+3,5],center=true);
  }
  // Raised sidewall ring.
  for (y=[-wheel_w/2, wheel_w/2])
    translate([0,y,0]) rotate([90,0,0])
      difference() {
        cylinder(h=1.2,d=wheel_d-3,center=true);
        cylinder(h=2,d=wheel_d-8,center=true);
      }
}

module axle_pair(xpos) {
  translate([xpos,body_w/2,ground_z]) rotate([90,0,0])
    cylinder(h=body_w+2*wheel_w-3,d=axle_d,center=true);
}

module pickup_body() {
  union() {
    // Main chassis and bumpers.
    translate([8,4,ground_z-9]) rounded_box([134,body_w-8,18],4);
    translate([1,9,ground_z-5]) rounded_box([12,body_w-18,10],3);
    translate([139,8,ground_z-5]) rounded_box([10,body_w-16,10],3);

    // Hood with a slightly raised centre line.
    translate([12,6,ground_z+4]) rounded_box([42,body_w-12,15],5);
    translate([22,body_w/2-11,ground_z+18]) rounded_box([28,22,3],1.5);

    // Cab: lower cabin plus sloped roof created with hull sections.
    translate([52,7,ground_z+2]) rounded_box([47,body_w-14,24],5);
    hull() {
      translate([58,10,ground_z+20]) rounded_box([7,body_w-20,15],3);
      translate([68,10,ground_z+34]) rounded_box([25,body_w-20,8],3);
    }

    // Open cargo-bed walls.
    translate([99,5,ground_z+5]) cube([39,4,18]);
    translate([99,body_w-9,ground_z+5]) cube([39,4,18]);
    translate([134,5,ground_z+5]) cube([4,body_w-10,18]);
    translate([99,9,ground_z+5]) cube([39,body_w-18,3]);

    // Generic grille bars, lights, and side steps.
    for (y=[18:10:48]) translate([5,y,ground_z+1]) cube([4,6,2]);
    for (y=[12,body_w-18]) translate([4,y,ground_z+8]) cube([3,8,5]);
    for (y=[1,body_w-4]) translate([50,y,ground_z-2]) rounded_box([50,3,4],1);

    axle_pair(38);
    axle_pair(117);

    // Turret socket in cargo bed.
    translate([117,body_w/2,ground_z+8]) cylinder(h=8,d=14);
  }
}

module toy_turret() {
  // Peg fits the cargo-bed socket; broad ring prevents over-insertion.
  translate([0,0,-7]) cylinder(h=8,d=14-2*fit_clearance);
  cylinder(h=4,d=25);
  translate([0,0,4]) sphere(d=20);
  // Stylised twin barrels: oversized and clearly toy-like.
  for (y=[-4,4])
    translate([-2,y,7]) rotate([0,78,0]) cylinder(h=35,d=5);
  translate([-7,-9,3]) rounded_box([13,18,12],3);
}

module assembled() {
  color([0.18,0.34,0.20]) pickup_body();
  for (x=[38,117], y=[-wheel_w/2+1,body_w+wheel_w/2-1])
    color([0.06,0.06,0.07]) translate([x,y,ground_z]) wheel();
  color([0.25,0.27,0.24]) translate([117,body_w/2,ground_z+16]) toy_turret();
  // Windows are visual overlays only in assembly preview.
  color([0.16,0.38,0.48,0.85]) {
    translate([57.5,15,ground_z+25]) rotate([0,-22,0]) cube([1,body_w-30,13]);
    translate([72,9.5,ground_z+25]) cube([19,1,12]);
    translate([72,body_w-10.5,ground_z+25]) cube([19,1,12]);
  }
}

if (mode == 1) pickup_body();
else if (mode == 2) wheel();
else if (mode == 3) toy_turret();
else if (mode == 4) {
  pickup_body();
  for (i=[0:3]) translate([25+i*36,92,wheel_d/2]) wheel();
  translate([115,100,7]) toy_turret();
}
else assembled();
