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

// Middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionsSuccessStatus: 200,
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
    const tuitionCollection = db.collection("tuitions");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");

    // Role Middlewares
    const verifyADMIN = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      if (user?.role !== "admin")
        return res.status(403).send({ message: "Admin only action!" });
      next();
    };

    const verifyTUTOR = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      if (user?.role !== "Tutor")
        return res.status(403).send({ message: "Tutor only action!" });
      next();
    };

    /*** Tuition Routes ***/
    app.post("/tuitions", verifyJWT, verifyTUTOR, async (req, res) => {
      try {
        const tuitionData = req.body;
        tuitionData.postedBy = { email: req.tokenEmail };
        const result = await tuitionCollection.insertOne(tuitionData);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error saving tuition", error });
      }
    });

    app.get("/tuitions", async (req, res) => {
      try {
        const result = await tuitionCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching tuitions", error });
      }
    });

    app.get("/tuitions/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await tuitionCollection.findOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching tuition", error });
      }
    });

    // Tutor's own tuitions
    app.get("/my-tuitions/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        if (req.tokenEmail !== email)
          return res.status(403).send({ message: "Forbidden" });
        const result = await tuitionCollection
          .find({ "postedBy.email": email })
          .toArray();
        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch tutor tuitions", error });
      }
    });

    /*** Orders Routes ***/
    app.get("/my-orders", verifyJWT, async (req, res) => {
      try {
        const result = await ordersCollection
          .find({ customer: req.tokenEmail })
          .toArray();
        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch customer orders", error });
      }
    });

    app.get(
      "/manage-orders/:email",
      verifyJWT,
      verifyTUTOR,
      async (req, res) => {
        try {
          const email = req.params.email;
          if (req.tokenEmail !== email)
            return res.status(403).send({ message: "Forbidden" });
          const result = await ordersCollection
            .find({ "seller.email": email })
            .toArray();
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to fetch tutor orders", error });
        }
      }
    );

    /*** Stripe Payment Routes ***/
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
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
        res
          .status(500)
          .send({ message: "Payment session creation failed", error });
      }
    });

    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

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

        res.send({
          transactionId: session.payment_intent,
          orderId: existingOrder?._id || null,
        });
      } catch (error) {
        res.status(500).send({ message: "Payment processing failed", error });
      }
    });

    /*** Users Routes ***/
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
        res
          .status(500)
          .send({ message: "Failed to save or update user", error });
      }
    });

    app.get("/user/role", verifyJWT, async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.tokenEmail });
        res.send({ role: user?.role || "Student" });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch user role", error });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB successfully.");
  } catch (err) {
    console.error(err);
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
