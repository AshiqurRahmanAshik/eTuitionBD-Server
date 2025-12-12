require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 3000;

// Decode Firebase admin key
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

// JWT middleware
const verifyJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).send({ message: "Unauthorized Access!" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// MongoDB client
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("etuitionDB");
    const tuitionCollection = db.collection("tuitions");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");

    /*** Tuitions Routes ***/
    // Save a tuition
    app.post("/tuitions", async (req, res) => {
      try {
        const tuitionData = req.body;
        const result = await tuitionCollection.insertOne(tuitionData);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error saving tuition", error });
      }
    });

    // Get all tuitions
    app.get("/tuitions", async (req, res) => {
      try {
        const result = await tuitionCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching tuitions", error });
      }
    });

    // Get a single tuition by id
    app.get("/tuitions/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await tuitionCollection.findOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching tuition", error });
      }
    });

    /*** Stripe Payment Routes ***/
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
        console.log(paymentInfo);

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "bdt",
                product_data: {
                  name: paymentInfo?.name,
                  description: paymentInfo?.description,
                },
                unit_amount: paymentInfo?.price * 100,
              },
              quantity: paymentInfo?.quantity || 1,
            },
          ],
          customer_email: paymentInfo?.customer?.email,
          mode: "payment",
          metadata: {
            tuitionId: paymentInfo?.tuitionId,
            customer: paymentInfo?.customer?.email,
          },
          success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/tuition/${paymentInfo?.tuitionId}`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Payment session creation failed" });
      }
    });

    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;

        if (!sessionId) {
          return res.status(400).send({ message: "Session ID is required" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (!session) {
          return res.status(404).send({ message: "Session not found" });
        }

        const tuition = await tuitionCollection.findOne({
          _id: new ObjectId(session.metadata.tuitionId),
        });

        const existingOrder = await ordersCollection.findOne({
          transactionId: session.payment_intent,
        });

        if (session.payment_status === "paid" && tuition && !existingOrder) {
          const orderInfo = {
            tuitionId: session.metadata.tuitionId,
            transactionId: session.payment_intent,
            customer: session.metadata.customer,
            status: "pending",
            subject: tuition.subject,
            className: tuition.className,
            medium: tuition.medium,
            location: tuition.location,
            schedule: tuition.schedule,
            phone: tuition.phone,
            price: session.amount_total / 100,
            seller: tuition.postedBy || {},
            createdAt: new Date(),
          };

          const result = await ordersCollection.insertOne(orderInfo);

          return res.send({
            transactionId: session.payment_intent,
            orderId: result.insertedId,
          });
        }

        return res.send({
          transactionId: session.payment_intent,
          orderId: existingOrder?._id || null,
        });
      } catch (error) {
        console.error("Payment success error:", error);
        res.status(500).send({ error: "Payment processing failed" });
      }
    });

    /*** Orders Routes ***/
    app.get("/my-orders/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await ordersCollection
          .find({ customer: email })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching customer orders:", error);
        res.status(500).send({ error: "Failed to fetch customer orders" });
      }
    });

    app.get("/manage-orders/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await ordersCollection
          .find({ "seller.email": email })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching tutor orders:", error);
        res.status(500).send({ error: "Failed to fetch tutor orders" });
      }
    });

    /*** Tutor Tuitions ***/
    app.get("/my-tuitions/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await tuitionCollection
          .find({ "postedBy.email": email })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching tutor tuitions:", error);
        res.status(500).send({ error: "Failed to fetch tutor tuitions" });
      }
    });

    /*** Users Routes ***/
    // Save or update a user
    app.post("/user", async (req, res) => {
      try {
        const userData = req.body;

        userData.role = userData.role || "Student";
        userData.created_at = new Date().toISOString();
        userData.last_loggedIn = new Date().toISOString();

        const query = { email: userData.email };
        const alreadyExists = await usersCollection.findOne(query);

        if (alreadyExists) {
          const result = await usersCollection.updateOne(query, {
            $set: {
              last_loggedIn: new Date().toISOString(),
              role: userData.role,
            },
          });
          return res.send(result);
        }

        const result = await usersCollection.insertOne(userData);
        res.send(result);
      } catch (error) {
        console.error("Error saving/updating user:", error);
        res.status(500).send({ error: "Failed to save or update user" });
      }
    });

    // Get a user's role by email
    app.get("/user/role/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });
        res.send({ role: user?.role || "Student" });
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).send({ error: "Failed to fetch user role" });
      }
    });

    // Get logged-in user's role (JWT required)
    app.get("/user/role", verifyJWT, async (req, res) => {
      try {
        const result = await usersCollection.findOne({ email: req.tokenEmail });
        res.send({ role: result?.role || "Student" });
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).send({ error: "Failed to fetch user role" });
      }
    });

    // Test MongoDB connection
    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB successfully.");
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
  }
}

run().catch(console.dir);

// Default route
app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
