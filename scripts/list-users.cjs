const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
db.user
  .findMany({
    select: {
      id: true,
      email: true,
      fullName: true,
      authProvider: true,
      createdAt: true,
      passwordHash: true,
    },
  })
  .then((users) => {
    if (!users.length) {
      console.log("No users found");
      return;
    }
    users.forEach((u) =>
      console.log(
        u.email,
        "| has_password:",
        !!u.passwordHash,
        "| provider:",
        u.authProvider,
        "| created:",
        u.createdAt
      )
    );
    console.log("Total:", users.length);
  })
  .finally(() => db.$disconnect());
