require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 3000;

// Initialize Firebase Admin
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// Middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
  })
);
app.use(express.json());

// JWT Middleware
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// MongoDB Client
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("etuitionDB");
    const tuitionsCollection = db.collection("tuitions");
    const applicationsCollection = db.collection("applications");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");
    const tutorRequestsCollection = db.collection("tutorRequests");
    const tutorsCollection = db.collection("tutors");

    /* ================= ROLE MIDDLEWARE ================= */
    const verifyADMIN = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      if (user?.role?.toLowerCase() !== "admin") {
        return res.status(403).send({ message: "Admin only action!" });
      }
      next();
    };

    const verifyTUTOR = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      if (user?.role?.toLowerCase() !== "tutor") {
        return res.status(403).send({ message: "Tutor only action!" });
      }
      next();
    };

    const verifySTUDENT = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      if (user?.role?.toLowerCase() !== "student") {
        return res.status(403).send({ message: "Student only action!" });
      }
      next();
    };

    /* ================= PUBLIC ENDPOINTS ================= */

    // ✅ Get latest tuitions (for home page)
    app.get("/latest-tuitions", async (req, res) => {
      try {
        const result = await tuitionsCollection
          .find({ status: "approved" })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching latest tuitions:", error);
        res.status(500).send({ message: "Failed to fetch latest tuitions" });
      }
    });

    // ✅ Get latest tutors (for home page)
    app.get("/latest-tutors", async (req, res) => {
      try {
        const tutors = await tutorsCollection
          .find({ status: "Active" })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();
        res.send(tutors);
      } catch (error) {
        console.error("Error fetching latest tutors:", error);
        res.status(500).send({ message: "Failed to fetch latest tutors" });
      }
    });

    // ✅ Get all tutors (public)
    app.get("/tutors", async (req, res) => {
      try {
        const tutors = await tutorsCollection.find().toArray();
        res.send(tutors);
      } catch (error) {
        console.error("Error fetching tutors:", error);
        res.status(500).send({ message: "Failed to fetch tutors" });
      }
    });

    // ✅ Get tutor profile by ID (secure - doesn't expose email in URL)
    app.get("/tutors/profile/:id", async (req, res) => {
      try {
        const { id } = req.params;

        // Validate ObjectId
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid tutor ID" });
        }

        const tutor = await tutorsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!tutor) {
          return res.status(404).send({ message: "Tutor not found" });
        }

        res.send(tutor);
      } catch (error) {
        console.error("Error fetching tutor profile:", error);
        res.status(500).send({ message: "Failed to fetch tutor profile" });
      }
    });

    // ✅ Get single tutor profile by email (legacy - kept for backward compatibility)
    app.get("/tutors/:email", async (req, res) => {
      try {
        const tutor = await tutorsCollection.findOne({
          email: req.params.email,
        });
        if (!tutor) {
          return res.status(404).send({ message: "Tutor not found" });
        }
        res.send(tutor);
      } catch (error) {
        console.error("Error fetching tutor:", error);
        res.status(500).send({ message: "Failed to fetch tutor" });
      }
    });

    /* ================= TUITIONS (STUDENT CRUD) ================= */

    // ✅ Student can post tuition (status: pending by default)
    app.post("/tuitions", verifyJWT, async (req, res) => {
      try {
        const tuitionData = {
          ...req.body,
          postedBy: {
            email: req.tokenEmail,
            name: req.body.studentName,
          },
          status: "pending",
          createdAt: new Date(),
        };
        const result = await tuitionsCollection.insertOne(tuitionData);
        res.send(result);
      } catch (error) {
        console.error("Error creating tuition:", error);
        res.status(500).send({ message: "Failed to create tuition" });
      }
    });

    // ✅ Get all APPROVED tuitions (public - for tutors to browse)
    app.get("/tuitions", async (req, res) => {
      try {
        const result = await tuitionsCollection
          .find({ status: "approved" })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching tuitions:", error);
        res.status(500).send({ message: "Failed to fetch tuitions" });
      }
    });

    // ✅ Search, Filter & Sort tuitions
    app.get("/tuitions/search", async (req, res) => {
      try {
        const { search, subject, class: className, location, sort } = req.query;

        let query = { status: "approved" };

        if (search) {
          query.$or = [
            { subject: { $regex: search, $options: "i" } },
            { location: { $regex: search, $options: "i" } },
          ];
        }

        if (subject) query.subject = subject;
        if (className) query.class = className;
        if (location) query.location = { $regex: location, $options: "i" };

        let sortOption = { createdAt: -1 };
        if (sort === "budget-asc") sortOption = { budget: 1 };
        if (sort === "budget-desc") sortOption = { budget: -1 };
        if (sort === "date-asc") sortOption = { createdAt: 1 };
        if (sort === "date-desc") sortOption = { createdAt: -1 };

        const result = await tuitionsCollection
          .find(query)
          .sort(sortOption)
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Error searching tuitions:", error);
        res.status(500).send({ message: "Failed to search tuitions" });
      }
    });

    // ✅ Pagination for tuitions
    app.get("/tuitions/paginated", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 9;
        const skip = (page - 1) * limit;

        const { search, subject, class: className, location, sort } = req.query;

        let query = { status: "approved" };

        if (search) {
          query.$or = [
            { subject: { $regex: search, $options: "i" } },
            { location: { $regex: search, $options: "i" } },
          ];
        }
        if (subject) query.subject = subject;
        if (className) query.class = className;
        if (location) query.location = { $regex: location, $options: "i" };

        let sortOption = { createdAt: -1 };
        if (sort === "budget-asc") sortOption = { budget: 1 };
        if (sort === "budget-desc") sortOption = { budget: -1 };
        if (sort === "date-asc") sortOption = { createdAt: 1 };
        if (sort === "date-desc") sortOption = { createdAt: -1 };

        const total = await tuitionsCollection.countDocuments(query);
        const tuitions = await tuitionsCollection
          .find(query)
          .sort(sortOption)
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({
          tuitions,
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalTuitions: total,
        });
      } catch (error) {
        console.error("Error fetching paginated tuitions:", error);
        res.status(500).send({ message: "Failed to fetch tuitions" });
      }
    });

    // ✅ Get single tuition details
    app.get("/tuitions/:id", async (req, res) => {
      try {
        const result = await tuitionsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      } catch (error) {
        console.error("Error fetching tuition:", error);
        res.status(500).send({ message: "Failed to fetch tuition" });
      }
    });

    // ✅ Get student's own tuitions
    app.get("/my-tuitions", verifyJWT, async (req, res) => {
      try {
        const result = await tuitionsCollection
          .find({ "postedBy.email": req.tokenEmail })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching my tuitions:", error);
        res.status(500).send({ message: "Failed to fetch tuitions" });
      }
    });

    // ✅ Update tuition
    app.patch("/tuitions/:id", verifyJWT, async (req, res) => {
      try {
        const tuitionId = req.params.id;
        const tuition = await tuitionsCollection.findOne({
          _id: new ObjectId(tuitionId),
        });

        if (tuition.postedBy.email !== req.tokenEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (tuition.status === "approved") {
          return res
            .status(400)
            .send({ message: "Cannot update approved tuition" });
        }

        const updateData = { ...req.body, updatedAt: new Date() };
        delete updateData._id;

        const result = await tuitionsCollection.updateOne(
          { _id: new ObjectId(tuitionId) },
          { $set: updateData }
        );

        res.send(result);
      } catch (error) {
        console.error("Error updating tuition:", error);
        res.status(500).send({ message: "Failed to update tuition" });
      }
    });

    // ✅ Delete tuition
    app.delete("/tuitions/:id", verifyJWT, async (req, res) => {
      try {
        const tuitionId = req.params.id;
        const tuition = await tuitionsCollection.findOne({
          _id: new ObjectId(tuitionId),
        });

        if (tuition.postedBy.email !== req.tokenEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await tuitionsCollection.deleteOne({
          _id: new ObjectId(tuitionId),
        });

        await applicationsCollection.deleteMany({ tuitionId });

        res.send(result);
      } catch (error) {
        console.error("Error deleting tuition:", error);
        res.status(500).send({ message: "Failed to delete tuition" });
      }
    });

    /* ================= TUTOR APPLICATIONS ================= */

    // ✅ Tutor applies to a tuition
    app.post("/applications", verifyJWT, verifyTUTOR, async (req, res) => {
      try {
        const { tuitionId, qualifications, experience, expectedSalary } =
          req.body;

        const existingApp = await applicationsCollection.findOne({
          tuitionId,
          tutorEmail: req.tokenEmail,
        });

        if (existingApp) {
          return res
            .status(409)
            .send({ message: "Already applied to this tuition" });
        }

        const tutor = await usersCollection.findOne({ email: req.tokenEmail });

        const applicationData = {
          tuitionId,
          tutorEmail: req.tokenEmail,
          tutorName: tutor.name,
          tutorImage: tutor.image,
          qualifications,
          experience,
          expectedSalary: parseFloat(expectedSalary),
          status: "pending",
          appliedAt: new Date(),
        };

        const result = await applicationsCollection.insertOne(applicationData);
        res.send(result);
      } catch (error) {
        console.error("Error creating application:", error);
        res.status(500).send({ message: "Failed to apply" });
      }
    });

    // ✅ Get applications for a specific tuition
    app.get("/tuitions/:id/applications", verifyJWT, async (req, res) => {
      try {
        const tuitionId = req.params.id;
        const tuition = await tuitionsCollection.findOne({
          _id: new ObjectId(tuitionId),
        });

        if (tuition.postedBy.email !== req.tokenEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const applications = await applicationsCollection
          .find({ tuitionId })
          .sort({ appliedAt: -1 })
          .toArray();

        res.send(applications);
      } catch (error) {
        console.error("Error fetching applications:", error);
        res.status(500).send({ message: "Failed to fetch applications" });
      }
    });

    // ✅ Get tutor's own applications (FIXED)
    app.get("/my-applications", verifyJWT, verifyTUTOR, async (req, res) => {
      try {
        const { status } = req.query; // Add query parameter for filtering

        let query = { tutorEmail: req.tokenEmail };

        // Add status filter if provided
        if (status) {
          query.status = status;
        }

        const applications = await applicationsCollection
          .find(query)
          .sort({ appliedAt: -1 })
          .toArray();

        const populatedApps = await Promise.all(
          applications.map(async (app) => {
            const tuition = await tuitionsCollection.findOne({
              _id: new ObjectId(app.tuitionId),
            });
            return { ...app, tuition };
          })
        );

        res.send(populatedApps);
      } catch (error) {
        console.error("Error fetching applications:", error);
        res.status(500).send({ message: "Failed to fetch applications" }); // FIXED: was res.send
      }
    });

    // ✅ Update application
    app.patch("/applications/:id", verifyJWT, verifyTUTOR, async (req, res) => {
      try {
        const appId = req.params.id;
        const application = await applicationsCollection.findOne({
          _id: new ObjectId(appId),
        });

        if (application.tutorEmail !== req.tokenEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (application.status !== "pending") {
          return res
            .status(400)
            .send({ message: "Cannot update non-pending application" });
        }

        const { qualifications, experience, expectedSalary } = req.body;
        const result = await applicationsCollection.updateOne(
          { _id: new ObjectId(appId) },
          {
            $set: {
              qualifications,
              experience,
              expectedSalary: parseFloat(expectedSalary),
              updatedAt: new Date(),
            },
          }
        );

        res.send(result);
      } catch (error) {
        console.error("Error updating application:", error);
        res.status(500).send({ message: "Failed to update application" });
      }
    });

    // ✅ Delete application
    app.delete(
      "/applications/:id",
      verifyJWT,
      verifyTUTOR,
      async (req, res) => {
        try {
          const appId = req.params.id;
          const application = await applicationsCollection.findOne({
            _id: new ObjectId(appId),
          });

          if (application.tutorEmail !== req.tokenEmail) {
            return res.status(403).send({ message: "Forbidden" });
          }

          if (application.status !== "pending") {
            return res
              .status(400)
              .send({ message: "Cannot delete non-pending application" });
          }

          const result = await applicationsCollection.deleteOne({
            _id: new ObjectId(appId),
          });

          res.send(result);
        } catch (error) {
          console.error("Error deleting application:", error);
          res.status(500).send({ message: "Failed to delete application" });
        }
      }
    );

    // ✅ Student rejects a tutor application
    app.patch("/applications/:id/reject", verifyJWT, async (req, res) => {
      try {
        const appId = req.params.id;
        const application = await applicationsCollection.findOne({
          _id: new ObjectId(appId),
        });

        const tuition = await tuitionsCollection.findOne({
          _id: new ObjectId(application.tuitionId),
        });

        if (tuition.postedBy.email !== req.tokenEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await applicationsCollection.updateOne(
          { _id: new ObjectId(appId) },
          { $set: { status: "rejected", rejectedAt: new Date() } }
        );

        res.send(result);
      } catch (error) {
        console.error("Error rejecting application:", error);
        res.status(500).send({ message: "Failed to reject application" });
      }
    });

    /* ================= PAYMENTS ================= */

    // ✅ Create checkout session
    app.post("/create-checkout-session", verifyJWT, async (req, res) => {
      try {
        const { applicationId, tuitionId, expectedSalary } = req.body;

        const application = await applicationsCollection.findOne({
          _id: new ObjectId(applicationId),
        });

        const tuition = await tuitionsCollection.findOne({
          _id: new ObjectId(tuitionId),
        });

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "bdt",
                product_data: {
                  name: `Tuition Payment - ${tuition.subject}`,
                  description: `Class ${tuition.class} - ${tuition.location}`,
                },
                unit_amount: expectedSalary * 100,
              },
              quantity: 1,
            },
          ],
          customer_email: req.tokenEmail,
          mode: "payment",
          metadata: {
            applicationId,
            tuitionId,
            studentEmail: req.tokenEmail,
            tutorEmail: application.tutorEmail,
          },
          success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/dashboard/my-tuitions`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Error creating checkout session:", error);
        res.status(500).send({ message: "Failed to create payment session" });
      }
    });

    // ✅ Handle successful payment (FIXED WITH DETAILED LOGGING)
    app.post("/payment-success", verifyJWT, async (req, res) => {
      try {
        const { sessionId } = req.body;
        console.log("📝 Processing payment for session:", sessionId);

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const { applicationId, tuitionId, studentEmail, tutorEmail } =
          session.metadata;

        console.log("📝 Payment metadata:", {
          applicationId,
          tuitionId,
          studentEmail,
          tutorEmail,
        });

        const exists = await ordersCollection.findOne({
          transactionId: session.payment_intent,
        });

        if (exists) {
          console.log("⚠️ Payment already processed");
          return res.send(exists);
        }

        console.log("💰 Stripe session amount_total:", session.amount_total);
        console.log("💵 Calculated amount:", session.amount_total / 100);

        const paymentRecord = {
          applicationId,
          tuitionId,
          transactionId: session.payment_intent,
          studentEmail,
          tutorEmail,
          amount: Number(session.amount_total / 100) || 0,
          status: "completed",
          paidAt: new Date(),
        };

        console.log("📝 Payment record to be saved:", paymentRecord);

        await ordersCollection.insertOne(paymentRecord);
        console.log("✅ Payment record created successfully");

        // Update the application status to approved
        const updateResult = await applicationsCollection.updateOne(
          { _id: new ObjectId(applicationId) },
          { $set: { status: "approved", approvedAt: new Date() } }
        );
        console.log(
          "✅ Application approved:",
          updateResult.modifiedCount,
          "documents updated"
        );

        // Verify the update
        const updatedApp = await applicationsCollection.findOne({
          _id: new ObjectId(applicationId),
        });
        console.log("✅ Verified application status:", updatedApp?.status);

        // Reject all other pending applications for this tuition
        const rejectResult = await applicationsCollection.updateMany(
          {
            tuitionId,
            _id: { $ne: new ObjectId(applicationId) },
            status: "pending",
          },
          { $set: { status: "rejected", rejectedAt: new Date() } }
        );
        console.log(
          "✅ Other applications rejected:",
          rejectResult.modifiedCount,
          "documents updated"
        );

        // Update tuition status to hired
        const tuitionUpdateResult = await tuitionsCollection.updateOne(
          { _id: new ObjectId(tuitionId) },
          {
            $set: {
              status: "hired",
              hiredTutor: tutorEmail,
              hiredAt: new Date(),
            },
          }
        );
        console.log(
          "✅ Tuition marked as hired:",
          tuitionUpdateResult.modifiedCount,
          "documents updated"
        );

        res.send({ message: "Payment successful", paymentRecord });
      } catch (error) {
        console.error("❌ Error processing payment:", error);
        res.status(500).send({ message: "Failed to process payment" });
      }
    });

    // ✅ Get student's payment history
    app.get("/my-payments", verifyJWT, async (req, res) => {
      try {
        const payments = await ordersCollection
          .find({ studentEmail: req.tokenEmail })
          .sort({ paidAt: -1 })
          .toArray();

        const populatedPayments = await Promise.all(
          payments.map(async (payment) => {
            const tuition = await tuitionsCollection.findOne({
              _id: new ObjectId(payment.tuitionId),
            });
            return { ...payment, tuition };
          })
        );

        res.send(populatedPayments);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).send({ message: "Failed to fetch payments" });
      }
    });

    // ✅ Get tutor's revenue history (FIXED - with tuition details)
    app.get("/tutor-revenue", verifyJWT, verifyTUTOR, async (req, res) => {
      try {
        const revenue = await ordersCollection
          .find({ tutorEmail: req.tokenEmail })
          .sort({ paidAt: -1 })
          .toArray();

        // Populate tuition details for each payment
        const populatedRevenue = await Promise.all(
          revenue.map(async (payment) => {
            const tuition = await tuitionsCollection.findOne({
              _id: new ObjectId(payment.tuitionId),
            });
            return { ...payment, tuition };
          })
        );

        const totalRevenue = revenue.reduce(
          (sum, payment) => sum + payment.amount,
          0
        );

        res.send({ revenue: populatedRevenue, totalRevenue });
      } catch (error) {
        console.error("Error fetching revenue:", error);
        res.status(500).send({ message: "Failed to fetch revenue" });
      }
    });

    // ✅ Get tutor's ongoing tuitions
    app.get(
      "/tutor-ongoing-tuitions",
      verifyJWT,
      verifyTUTOR,
      async (req, res) => {
        try {
          const tuitions = await tuitionsCollection
            .find({
              status: "hired",
              hiredTutor: req.tokenEmail,
            })
            .sort({ hiredAt: -1 })
            .toArray();

          res.send(tuitions);
        } catch (error) {
          console.error("Error fetching ongoing tuitions:", error);
          res.status(500).send({ message: "Failed to fetch tuitions" });
        }
      }
    );

    /* ================= USERS ================= */

    app.post("/user", async (req, res) => {
      try {
        const userData = {
          ...req.body,
          role: (req.body.role || "student").toLowerCase(),
          created_at: new Date(),
          last_loggedIn: new Date(),
        };

        const exists = await usersCollection.findOne({
          email: userData.email,
        });

        if (exists) {
          await usersCollection.updateOne(
            { email: userData.email },
            { $set: { last_loggedIn: new Date() } }
          );
          return res.send({ message: "User updated" });
        }

        const result = await usersCollection.insertOne(userData);
        res.send(result);
      } catch (error) {
        console.error("Error saving user:", error);
        res.status(500).send({ message: "Failed to save user" });
      }
    });

    app.get("/user/role", verifyJWT, async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.tokenEmail });
        res.send({ role: user?.role || "student" });
      } catch (error) {
        console.error("Error fetching role:", error);
        res.status(500).send({ message: "Failed to fetch role" });
      }
    });

    // ✅ Get own profile
    app.get("/profile", verifyJWT, async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.tokenEmail });
        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }
        res.send(user);
      } catch (error) {
        console.error("Error fetching profile:", error);
        res.status(500).send({ message: "Failed to fetch profile" });
      }
    });

    // ✅ Update own profile
    app.patch("/profile", verifyJWT, async (req, res) => {
      try {
        const { name, image, phone } = req.body;

        const updateData = {};
        if (name) updateData.name = name;
        if (image) updateData.image = image;
        if (phone) updateData.phone = phone;
        updateData.updatedAt = new Date();

        const result = await usersCollection.updateOne(
          { email: req.tokenEmail },
          { $set: updateData }
        );

        res.send(result);
      } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).send({ message: "Failed to update profile" });
      }
    });

    // ✅ Get all users (admin)
    app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).send({ message: "Failed to fetch users" });
      }
    });

    // ✅ Update user (admin)
    app.patch("/users/:email", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const email = req.params.email;
        const { name, role, image } = req.body;

        const updateData = {};
        if (name) updateData.name = name;
        if (role) updateData.role = role.toLowerCase();
        if (image) updateData.image = image;

        const result = await usersCollection.updateOne(
          { email },
          { $set: updateData }
        );

        res.send(result);
      } catch (error) {
        console.error("Error updating user:", error);
        res.status(500).send({ message: "Failed to update user" });
      }
    });

    // ✅ Delete user (admin)
    app.delete("/users/:email", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const email = req.params.email;

        if (email === req.tokenEmail) {
          return res
            .status(400)
            .send({ message: "Cannot delete your own account" });
        }

        const result = await usersCollection.deleteOne({ email });
        res.send(result);
      } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).send({ message: "Failed to delete user" });
      }
    });

    /* ================= BECOME TUTOR ================= */

    app.post("/become-tutor", verifyJWT, async (req, res) => {
      try {
        const email = req.tokenEmail;
        const user = await usersCollection.findOne({ email });

        if (user?.role?.toLowerCase() === "tutor") {
          return res.status(400).send({ message: "Already a Tutor" });
        }

        const alreadyRequested = await tutorRequestsCollection.findOne({
          email,
          status: "pending",
        });

        if (alreadyRequested) {
          return res.status(409).send({ message: "Request already sent" });
        }

        const result = await tutorRequestsCollection.insertOne({
          email,
          name: user.name,
          image: user.image,
          status: "pending",
          requestedAt: new Date(),
        });

        res.send(result);
      } catch (error) {
        console.error("Error creating tutor request:", error);
        res.status(500).send({ message: "Failed to create request" });
      }
    });

    /* ================= ADMIN ENDPOINTS ================= */

    // Get tutor requests
    app.get("/tutor-requests", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const result = await tutorRequestsCollection
          .find({ status: "pending" })
          .toArray();

        console.log(`Found ${result.length} pending tutor requests`);
        res.send(result);
      } catch (error) {
        console.error("Error fetching tutor requests:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Approve tutor request
    app.patch("/approve-tutor", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const { email } = req.body;

        await usersCollection.updateOne({ email }, { $set: { role: "tutor" } });

        await tutorRequestsCollection.updateOne(
          { email },
          { $set: { status: "approved", approvedAt: new Date() } }
        );

        res.send({ message: "Tutor approved successfully" });
      } catch (error) {
        console.error("Error approving tutor:", error);
        res.status(500).send({ message: "Failed to approve tutor" });
      }
    });

    // ✅ Get all tuitions (admin)
    app.get("/admin/tuitions", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const tuitions = await tuitionsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.send(tuitions);
      } catch (error) {
        console.error("Error fetching tuitions:", error);
        res.status(500).send({ message: "Failed to fetch tuitions" });
      }
    });

    // ✅ Approve tuition (admin)
    app.patch(
      "/admin/tuitions/:id/approve",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        try {
          const result = await tuitionsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: "approved", approvedAt: new Date() } }
          );
          res.send(result);
        } catch (error) {
          console.error("Error approving tuition:", error);
          res.status(500).send({ message: "Failed to approve tuition" });
        }
      }
    );

    // ✅ Reject tuition (admin)
    app.patch(
      "/admin/tuitions/:id/reject",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        try {
          const result = await tuitionsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: "rejected", rejectedAt: new Date() } }
          );
          res.send(result);
        } catch (error) {
          console.error("Error rejecting tuition:", error);
          res.status(500).send({ message: "Failed to reject tuition" });
        }
      }
    );

    // ✅ Get platform statistics (admin)
    app.get("/admin/statistics", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalTuitions = await tuitionsCollection.countDocuments();
        const totalApplications = await applicationsCollection.countDocuments();
        const totalRevenue = await ordersCollection
          .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
          .toArray();

        const students = await usersCollection.countDocuments({
          role: { $regex: /^student$/i },
        });
        const tutors = await usersCollection.countDocuments({
          role: { $regex: /^tutor$/i },
        });
        const admins = await usersCollection.countDocuments({
          role: { $regex: /^admin$/i },
        });

        const pendingTuitions = await tuitionsCollection.countDocuments({
          status: "pending",
        });
        const approvedTuitions = await tuitionsCollection.countDocuments({
          status: "approved",
        });
        const hiredTuitions = await tuitionsCollection.countDocuments({
          status: "hired",
        });

        res.send({
          totalUsers,
          totalTuitions,
          totalApplications,
          totalRevenue: totalRevenue[0]?.total || 0,
          usersByRole: { students, tutors, admins },
          tuitionsByStatus: {
            pendingTuitions,
            approvedTuitions,
            hiredTuitions,
          },
        });
      } catch (error) {
        console.error("Error fetching statistics:", error);
        res.status(500).send({ message: "Failed to fetch statistics" });
      }
    });

    // ✅ Get all transactions (admin)
    app.get("/admin/transactions", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const transactions = await ordersCollection
          .find()
          .sort({ paidAt: -1 })
          .toArray();

        const populatedTransactions = await Promise.all(
          transactions.map(async (transaction) => {
            const tuition = await tuitionsCollection.findOne({
              _id: new ObjectId(transaction.tuitionId),
            });
            const student = await usersCollection.findOne({
              email: transaction.studentEmail,
            });
            const tutor = await usersCollection.findOne({
              email: transaction.tutorEmail,
            });
            return { ...transaction, tuition, student, tutor };
          })
        );

        res.send(populatedTransactions);
      } catch (error) {
        console.error("Error fetching transactions:", error);
        res.status(500).send({ message: "Failed to fetch transactions" });
      }
    });

    /* ================= CONTACT FORM ================= */

    app.post("/contact", async (req, res) => {
      try {
        const contactData = {
          ...req.body,
          createdAt: new Date(),
        };
        const result = await db.collection("contacts").insertOne(contactData);
        res.send(result);
      } catch (error) {
        console.error("Error saving contact:", error);
        res.status(500).send({ message: "Failed to save contact" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB connected successfully");
  } catch (error) {
    console.error(error);
  }
}

run();

app.get("/", (req, res) => {
  res.send("eTuitionBD Server is Running...");
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
