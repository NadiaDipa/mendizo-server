import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required.");
}

const client = new MongoClient(process.env.MONGODB_URI);

async function seed() {
  try {
    await client.connect();
    console.log("Connected to MongoDB for seeding...");

    const db = client.db("mendizo");
    const usersCol = db.collection("user");
    const servicesCol = db.collection("services");
    const bookingsCol = db.collection("bookings");
    const paymentsCol = db.collection("payments");

    // 1. Seed or update Admin
    const adminUser = {
      name: "Mendizo Admin",
      email: "admin@mendizo.com",
      role: "admin",
      phone: "+880 1700 000001",
      area: "Gulshan, Dhaka",
      bio: "Mendizo System Administrator & Operations Lead.",
      image: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200&auto=format&fit=crop&q=80",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date(),
    };

    await usersCol.updateOne(
      { email: adminUser.email },
      { $set: adminUser },
      { upsert: true }
    );
    // Legacy mirror support
    await usersCol.updateOne(
      { email: "admin@fixmate.com" },
      { $set: { ...adminUser, email: "admin@fixmate.com" } },
      { upsert: true }
    );
    console.log("Admin seeded: admin@mendizo.com");

    // 2. Seed Technicians (At least 2 required)
    const technician1 = {
      name: "Rafiqul Islam",
      email: "rafiqul.tech@mendizo.com",
      role: "technician",
      phone: "+880 1711 112233",
      area: "Dhanmondi, Dhaka",
      bio: "Certified HVAC & refrigeration technician with 8+ years of field experience.",
      image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&auto=format&fit=crop&q=80",
      createdAt: new Date("2026-01-10"),
      updatedAt: new Date(),
    };

    const technician2 = {
      name: "Tanvir Ahmed",
      email: "tanvir.tech@mendizo.com",
      role: "technician",
      phone: "+880 1722 334455",
      area: "Mirpur, Dhaka",
      bio: "Apple & Microsoft certified hardware technician specializing in laptop & smartphone microsoldering.",
      image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200&auto=format&fit=crop&q=80",
      createdAt: new Date("2026-01-12"),
      updatedAt: new Date(),
    };

    const technician3 = {
      name: "Sumon Hossain",
      email: "sumon.tech@mendizo.com",
      role: "technician",
      phone: "+880 1733 445566",
      area: "Uttara, Dhaka",
      bio: "Master technician for washing machines, TVs, and heavy home appliances.",
      image: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=200&auto=format&fit=crop&q=80",
      createdAt: new Date("2026-01-15"),
      updatedAt: new Date(),
    };

    await usersCol.updateOne({ email: technician1.email }, { $set: technician1 }, { upsert: true });
    await usersCol.updateOne({ email: technician2.email }, { $set: technician2 }, { upsert: true });
    await usersCol.updateOne({ email: technician3.email }, { $set: technician3 }, { upsert: true });
    // Legacy mirrors
    await usersCol.updateOne({ email: "rafiqul.tech@fixmate.com" }, { $set: { ...technician1, email: "rafiqul.tech@fixmate.com" } }, { upsert: true });
    await usersCol.updateOne({ email: "tanvir.tech@fixmate.com" }, { $set: { ...technician2, email: "tanvir.tech@fixmate.com" } }, { upsert: true });
    await usersCol.updateOne({ email: "sumon.tech@fixmate.com" }, { $set: { ...technician3, email: "sumon.tech@fixmate.com" } }, { upsert: true });
    console.log("Technicians seeded (Rafiqul, Tanvir, Sumon)");

    // 3. Seed Customer
    const customerUser = {
      name: "Nadia Dipa",
      email: "customer@mendizo.com",
      role: "customer",
      phone: "+880 1755 998877",
      area: "Banani, Dhaka",
      bio: "Verified Mendizo customer.",
      image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&auto=format&fit=crop&q=80",
      createdAt: new Date("2026-01-20"),
      updatedAt: new Date(),
    };

    await usersCol.updateOne({ email: customerUser.email }, { $set: customerUser }, { upsert: true });
    await usersCol.updateOne({ email: "customer@fixmate.com" }, { $set: { ...customerUser, email: "customer@fixmate.com" } }, { upsert: true });
    console.log("Customer seeded: customer@mendizo.com");

    // 4. Seed 14+ Approved Services across 7 Categories
    const sampleServices = [
      {
        title: "Split AC Deep Cleaning & Servicing",
        category: "AC",
        description: "Complete jet wash chemical cleaning of indoor and outdoor AC units, airflow check, cooling coil inspection, and bacterial disinfection.",
        basePrice: 15,
        estimatedDuration: "2-3 hours",
        serviceMode: "Home Visit",
        serviceArea: "Dhanmondi, Dhaka",
        image: "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=600&auto=format&fit=crop&q=80",
        technicianName: technician1.name,
        technicianEmail: technician1.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-01"),
      },
      {
        title: "AC Gas Leakage Repair & Refill",
        category: "AC",
        description: "Precision nitrogen pressure testing, leak sealing, vacuuming, and genuine R32/R410A refrigerant gas recharging.",
        basePrice: 35,
        estimatedDuration: "1-2 hours",
        serviceMode: "Home Visit",
        serviceArea: "Dhanmondi, Dhaka",
        image: "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=600&auto=format&fit=crop&q=80",
        technicianName: technician1.name,
        technicianEmail: technician1.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-02"),
      },
      {
        title: "iPhone & Android Screen Replacement",
        category: "Smartphone",
        description: "Grade-A OLED / AMOLED display replacement with True Tone restoration, touch calibration, and a 90-day warranty.",
        basePrice: 40,
        estimatedDuration: "1-2 hours",
        serviceMode: "Shop Drop-off",
        serviceArea: "Mirpur, Dhaka",
        image: "https://images.unsplash.com/photo-1597740985671-2a8a3b80532e?w=600&auto=format&fit=crop&q=80",
        technicianName: technician2.name,
        technicianEmail: technician2.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-03"),
      },
      {
        title: "Smartphone Battery Replacement",
        category: "Smartphone",
        description: "Zero-cycle high capacity battery replacement for iPhone, Samsung, Xiaomi and OnePlus with safety inspection.",
        basePrice: 20,
        estimatedDuration: "45 mins",
        serviceMode: "Shop Drop-off",
        serviceArea: "Mirpur, Dhaka",
        image: "https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?w=600&auto=format&fit=crop&q=80",
        technicianName: technician2.name,
        technicianEmail: technician2.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-04"),
      },
      {
        title: "Laptop Motherboard & Power Rail Repair",
        category: "Laptop & PC",
        description: "Component-level micro-soldering, short-circuit diagnostics, power IC replacement, and liquid spill ultrasonic cleaning.",
        basePrice: 50,
        estimatedDuration: "1-2 days",
        serviceMode: "Shop Drop-off",
        serviceArea: "Mirpur, Dhaka",
        image: "https://images.unsplash.com/photo-1588872657578-7efd1f1555ed?w=600&auto=format&fit=crop&q=80",
        technicianName: technician2.name,
        technicianEmail: technician2.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-05"),
      },
      {
        title: "Laptop Thermal Paste & Fan Servicing",
        category: "Laptop & PC",
        description: "Eliminate thermal throttling with Arctic MX-4 thermal paste re-pasting, copper heat-pipe inspection, and cooling fan lubrication.",
        basePrice: 18,
        estimatedDuration: "1 hour",
        serviceMode: "Home Visit",
        serviceArea: "Mirpur, Dhaka",
        image: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=600&auto=format&fit=crop&q=80",
        technicianName: technician2.name,
        technicianEmail: technician2.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-06"),
      },
      {
        title: "Refrigerator Compressor & Gas Repair",
        category: "Refrigerator",
        description: "Diagnosis and replacement of inverter/non-inverter refrigerator compressors, capillary tube unclogging, and thermostat replacement.",
        basePrice: 45,
        estimatedDuration: "3-4 hours",
        serviceMode: "Home Visit",
        serviceArea: "Dhanmondi, Dhaka",
        image: "https://images.unsplash.com/photo-1571175443880-49e1d25b2bc5?w=600&auto=format&fit=crop&q=80",
        technicianName: technician1.name,
        technicianEmail: technician1.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-07"),
      },
      {
        title: "Frost-Free Refrigerator Defrost Troubleshooting",
        category: "Refrigerator",
        description: "Repair of faulty defrost bimetal sensors, defrost heaters, fan motor issues, and timer PCB troubleshooting.",
        basePrice: 22,
        estimatedDuration: "2 hours",
        serviceMode: "Home Visit",
        serviceArea: "Dhanmondi, Dhaka",
        image: "https://images.unsplash.com/photo-1584992236310-6edddc08acff?w=600&auto=format&fit=crop&q=80",
        technicianName: technician1.name,
        technicianEmail: technician1.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-08"),
      },
      {
        title: "Washing Machine Drum & Motor Overhaul",
        category: "Washing Machine",
        description: "Bearing replacement, drive belt adjustment, direct-drive inverter motor diagnosis, and water drainage pump unclogging.",
        basePrice: 30,
        estimatedDuration: "2-3 hours",
        serviceMode: "Home Visit",
        serviceArea: "Uttara, Dhaka",
        image: "https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?w=600&auto=format&fit=crop&q=80",
        technicianName: technician3.name,
        technicianEmail: technician3.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-09"),
      },
      {
        title: "Front Load Washer Door Seal & PCB Repair",
        category: "Washing Machine",
        description: "Replacement of mouldy door bellows (gasket), water inlet valve testing, and electronic motherboard relay repairs.",
        basePrice: 25,
        estimatedDuration: "1-2 hours",
        serviceMode: "Home Visit",
        serviceArea: "Uttara, Dhaka",
        image: "https://images.unsplash.com/photo-1545173168-9f1947eebb7f?w=600&auto=format&fit=crop&q=80",
        technicianName: technician3.name,
        technicianEmail: technician3.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-10"),
      },
      {
        title: "Smart LED / OLED TV Backlight & Panel Repair",
        category: "TV",
        description: "Fix black screen with sound, flickering backlight strip replacement, T-Con board repairs, and HDMI port replacement.",
        basePrice: 38,
        estimatedDuration: "1 day",
        serviceMode: "Shop Drop-off",
        serviceArea: "Uttara, Dhaka",
        image: "https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=600&auto=format&fit=crop&q=80",
        technicianName: technician3.name,
        technicianEmail: technician3.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-11"),
      },
      {
        title: "Home Electrical Short Circuit & Wiring Fix",
        category: "Electrical",
        description: "Master electrician service for circuit breaker tripping, DB board rewiring, earthing/grounding tests, and safety audit.",
        basePrice: 20,
        estimatedDuration: "2 hours",
        serviceMode: "Home Visit",
        serviceArea: "Uttara, Dhaka",
        image: "https://images.unsplash.com/photo-1621905252507-b35492cc74b4?w=600&auto=format&fit=crop&q=80",
        technicianName: technician3.name,
        technicianEmail: technician3.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-12"),
      },
      {
        title: "Ceiling Fan & Exhaust Fan Installation & Rewinding",
        category: "Electrical",
        description: "High speed ceiling fan bearing change, motor rewinding, capacitor upgrade, and silent balance calibration.",
        basePrice: 12,
        estimatedDuration: "1 hour",
        serviceMode: "Home Visit",
        serviceArea: "Uttara, Dhaka",
        image: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&auto=format&fit=crop&q=80",
        technicianName: technician3.name,
        technicianEmail: technician3.email,
        approvalStatus: "approved",
        isAvailable: true,
        createdAt: new Date("2026-02-13"),
      },
      {
        title: "Pending Approval: Custom Gaming Rig Diagnostics",
        category: "Laptop & PC",
        description: "Overclock stability testing, GPU thermal pad replacement, custom water loop leak inspection.",
        basePrice: 30,
        estimatedDuration: "1 day",
        serviceMode: "Shop Drop-off",
        serviceArea: "Mirpur, Dhaka",
        image: "https://images.unsplash.com/photo-1587202372775-e229f172b9d7?w=600&auto=format&fit=crop&q=80",
        technicianName: technician2.name,
        technicianEmail: technician2.email,
        approvalStatus: "pending",
        isAvailable: true,
        createdAt: new Date("2026-02-14"),
      },
    ];

    for (const service of sampleServices) {
      await servicesCol.updateOne(
        { title: service.title },
        { $set: service },
        { upsert: true }
      );
    }
    console.log(`Seeded ${sampleServices.length} realistic services.`);

    // 5. Seed sample bookings with varied statuses
    const firstService = await servicesCol.findOne({ title: "Split AC Deep Cleaning & Servicing" });
    const secondService = await servicesCol.findOne({ title: "iPhone & Android Screen Replacement" });
    const thirdService = await servicesCol.findOne({ title: "Washing Machine Drum & Motor Overhaul" });

    if (firstService && secondService && thirdService) {
      // Completed & Paid booking
      const paidBooking = {
        serviceId: firstService._id.toString(),
        serviceTitle: firstService.title,
        serviceImage: firstService.image,
        category: firstService.category,
        basePrice: firstService.basePrice,
        technicianName: firstService.technicianName,
        technicianEmail: firstService.technicianEmail,
        customerName: customerUser.name,
        customerEmail: customerUser.email,
        customerPhone: customerUser.phone,
        address: "House 12, Road 4, Banani, Dhaka",
        preferredDate: new Date("2026-02-10"),
        problemDescription: "AC is making a loud buzzing noise and not blowing cold air at all.",
        status: "completed",
        finalAmount: 18,
        amount: 18,
        paymentStatus: "paid",
        createdAt: new Date("2026-02-08"),
        updatedAt: new Date("2026-02-10"),
      };

      const paidResult = await bookingsCol.updateOne(
        {
          customerEmail: customerUser.email,
          serviceId: firstService._id.toString(),
          status: "completed",
        },
        { $set: paidBooking },
        { upsert: true }
      );

      const bookingRecord = await bookingsCol.findOne({
        customerEmail: customerUser.email,
        serviceId: firstService._id.toString(),
        status: "completed",
      });

      // Insert matching payment record
      if (bookingRecord) {
        const paymentDoc = {
          bookingId: bookingRecord._id.toString(),
          serviceTitle: firstService.title,
          customerName: customerUser.name,
          customerEmail: customerUser.email,
          technicianName: firstService.technicianName,
          technicianEmail: firstService.technicianEmail,
          amount: 18,
          currency: "usd",
          transactionId: "TXN-8F92A1B7",
          stripeSessionId: "cs_test_mock_seed_session_001",
          paymentStatus: "paid",
          paidAt: new Date("2026-02-10T14:30:00Z"),
        };

        await paymentsCol.updateOne(
          { stripeSessionId: paymentDoc.stripeSessionId },
          { $set: paymentDoc },
          { upsert: true }
        );
        console.log("Seeded completed & paid booking and payment record.");
      }

      // In-progress booking
      const inProgressBooking = {
        serviceId: secondService._id.toString(),
        serviceTitle: secondService.title,
        serviceImage: secondService.image,
        category: secondService.category,
        basePrice: secondService.basePrice,
        technicianName: secondService.technicianName,
        technicianEmail: secondService.technicianEmail,
        customerName: customerUser.name,
        customerEmail: customerUser.email,
        customerPhone: customerUser.phone,
        address: "House 12, Road 4, Banani, Dhaka",
        preferredDate: new Date("2026-02-18"),
        problemDescription: "My iPhone 14 Pro screen is shattered after dropping it on concrete.",
        status: "in-progress",
        finalAmount: 40,
        amount: 40,
        paymentStatus: "unpaid",
        createdAt: new Date("2026-02-15"),
        updatedAt: new Date("2026-02-16"),
      };

      await bookingsCol.updateOne(
        {
          customerEmail: customerUser.email,
          serviceId: secondService._id.toString(),
          status: "in-progress",
        },
        { $set: inProgressBooking },
        { upsert: true }
      );

      // Completed but Unpaid booking (so Pay Now button is visible and testable!)
      const completedUnpaidBooking = {
        serviceId: thirdService._id.toString(),
        serviceTitle: thirdService.title,
        serviceImage: thirdService.image,
        category: thirdService.category,
        basePrice: thirdService.basePrice,
        technicianName: thirdService.technicianName,
        technicianEmail: thirdService.technicianEmail,
        customerName: customerUser.name,
        customerEmail: customerUser.email,
        customerPhone: customerUser.phone,
        address: "House 12, Road 4, Banani, Dhaka",
        preferredDate: new Date("2026-02-16"),
        problemDescription: "Washing machine vibrates excessively during the final spin cycle.",
        status: "completed",
        finalAmount: 32,
        amount: 32,
        paymentStatus: "unpaid",
        createdAt: new Date("2026-02-14"),
        updatedAt: new Date("2026-02-16"),
      };

      await bookingsCol.updateOne(
        {
          customerEmail: customerUser.email,
          serviceId: thirdService._id.toString(),
          status: "completed",
          paymentStatus: "unpaid",
        },
        { $set: completedUnpaidBooking },
        { upsert: true }
      );

      console.log("Seeded testable bookings: 1 completed+paid, 1 in-progress, 1 completed+unpaid (Ready for Pay Now test).");
    }

    console.log("Database successfully seeded!");
  } catch (error) {
    console.error("Seeding error:", error);
  } finally {
    await client.close();
  }
}

seed();
