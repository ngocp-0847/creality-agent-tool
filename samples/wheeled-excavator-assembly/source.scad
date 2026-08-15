// Generic wheeled excavator assembly, dimensioned as a printable toy/model.
// mode: 0=assembly, 1=carrier/body, 2=wheel, 3=boom assembly, 4=print layout,
//       5=wheel/axle fit coupon
mode = 0;

vehicle_l = 165;
vehicle_w = 76;
wheel_d = 38;
wheel_w = 14;
axle_d = 5;
fit = 0.40;
wheel_fit = 0.18; // radial clearance: 5.00 mm axle -> 5.36 mm wheel bore
boom_pin_d = 8;

$fn = 44;

module rounded_box(s=[10,10,10],r=2) {
  x=s[0]; y=s[1]; z=s[2];
  hull() for (xx=[r,x-r], yy=[r,y-r])
    translate([xx,yy,r]) cylinder(h=max(z-2*r,0.1),r=r);
}

module pin_between(a,b,d) {
  hull() { translate(a) sphere(d=d); translate(b) sphere(d=d); }
}

module tire() {
  difference() {
    union() {
      rotate([90,0,0]) cylinder(h=wheel_w,d=wheel_d,center=true);
      // Raised hub is part of the wheel but remains hollow.
      rotate([90,0,0]) cylinder(h=wheel_w+0.8,d=14,center=true);
    }
    // True through-bore for a removable friction fit on the printed axle.
    rotate([90,0,0]) cylinder(h=wheel_w+3,d=axle_d+2*wheel_fit,center=true);
    // Lead-in cones make the wheel easier to start without splitting the hub.
    for (y=[-(wheel_w+1)/2,(wheel_w+1)/2])
      translate([0,y,0]) rotate([90,0,0])
        cylinder(h=1.2,d1=axle_d+1.4,d2=axle_d+2*wheel_fit,center=true);
    for (a=[0:30:330]) rotate([0,a,0])
      translate([wheel_d/2,0,0]) cube([5,wheel_w+3,6],center=true);
  }
}

module wheel_fit_coupon() {
  // Print this small part first. It duplicates the real axle and wheel bore.
  translate([-10,0,0]) rotate([90,0,0]) cylinder(h=18,d=axle_d,center=true);
  translate([10,0,0]) difference() {
    rotate([90,0,0]) cylinder(h=8,d=14,center=true);
    rotate([90,0,0]) cylinder(h=10,d=axle_d+2*wheel_fit,center=true);
  }
}

module undercarriage() {
  union() {
    translate([12,8,23]) rounded_box([141,vehicle_w-16,18],5);
    translate([22,13,37]) rounded_box([120,vehicle_w-26,9],3);
    // Front and rear stabilizer bars.
    for (x=[23,142]) {
      translate([x-3,2,15]) rounded_box([6,vehicle_w-4,6],2);
      for (y=[1,vehicle_w-7]) translate([x-7,y,5]) rounded_box([14,6,12],2);
    }
    // Axles.
    for (x=[42,126]) translate([x,vehicle_w/2,24]) rotate([90,0,0])
      cylinder(h=vehicle_w+2*wheel_w-4,d=axle_d,center=true);
    // Slew-ring base and central pivot.
    translate([89,vehicle_w/2,45]) cylinder(h=8,d=53);
    translate([89,vehicle_w/2,52]) cylinder(h=8,d=12);
  }
}

module upper_body() {
  union() {
    // Counterweight and engine house.
    translate([76,10,55]) rounded_box([65,vehicle_w-20,31],8);
    translate([116,14,78]) rounded_box([26,vehicle_w-28,10],4);
    // Cabin shell, left side, with roof and pillars.
    translate([55,8,58]) rounded_box([38,34,34],5);
    translate([57,8,88]) rounded_box([38,36,5],2);
    // Exhaust and work light housings.
    translate([128,54,83]) cylinder(h=18,d=7);
    translate([55,13,88]) rounded_box([8,7,6],2);
    // Boom mounting ears with removable horizontal pin hole.
    for (y=[47,61])
      difference() {
        translate([73,y,64]) rotate([90,0,0]) cylinder(h=7,d=25,center=true);
        translate([73,y,64]) rotate([90,0,0])
          cylinder(h=9,d=boom_pin_d+2*fit,center=true);
      }
  }
}

module carrier_body() {
  undercarriage();
  upper_body();
  // Preview-style window inserts remain printable as shallow relief.
  translate([57,7.5,67]) cube([28,2,18]);
  translate([55,15,67]) cube([2,20,18]);
}

module bucket() {
  difference() {
    hull() {
      translate([0,-13,0]) rotate([90,0,0]) cylinder(h=26,d=28,center=true);
      translate([24,-13,-11]) cube([18,26,8]);
    }
    translate([5,-11,2]) scale([0.75,0.78,0.7])
      hull() {
        rotate([90,0,0]) cylinder(h=28,d=24,center=true);
        translate([24,0,-10]) cube([15,28,7],center=true);
      }
  }
  // Five blunt teeth.
  for (y=[-10,-5,0,5,10]) translate([39,y,-12]) cube([9,3,4]);
}

module boom_group() {
  // Root boss aligns with body mounting ears.
  difference() {
    rotate([90,0,0]) cylinder(h=12,d=24,center=true);
    rotate([90,0,0]) cylinder(h=16,d=boom_pin_d+2*fit,center=true);
  }
  // Main boom, dipper arm and reinforcing ribs.
  pin_between([4,0,6],[54,0,52],15);
  pin_between([54,0,52],[88,0,18],13);
  translate([85,0,13]) rotate([0,-18,0]) bucket();
  // Simulated hydraulic cylinders, fused to the removable assembly.
  pin_between([8,-8,8],[48,-8,45],5);
  pin_between([50,8,45],[82,8,20],4.5);
  // Blunt oversized joint caps.
  for (p=[[54,0,52],[88,0,18]]) translate(p)
    rotate([90,0,0]) cylinder(h=18,d=18,center=true);
}

module assembled() {
  color([0.90,0.59,0.05]) carrier_body();
  for (x=[42,126], y=[-wheel_w/2+2,vehicle_w+wheel_w/2-2])
    color([0.055,0.055,0.06]) translate([x,y,24]) tire();
  color([0.94,0.64,0.08]) translate([73,54,64]) boom_group();
  color([0.10,0.25,0.30,0.9]) {
    translate([57,6.8,67]) cube([28,1.2,18]);
    translate([54.8,15,67]) cube([1.2,20,18]);
  }
}

if (mode==1) carrier_body();
else if (mode==2) tire();
else if (mode==3) boom_group();
else if (mode==4) {
  carrier_body();
  for (i=[0:3]) translate([25+i*38,103,wheel_d/2]) tire();
  translate([45,150,18]) rotate([0,18,0]) boom_group();
}
else if (mode==5) wheel_fit_coupon();
else assembled();
