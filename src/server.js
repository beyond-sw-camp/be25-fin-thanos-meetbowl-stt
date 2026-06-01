import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Meetbowl SST API listening on http://127.0.0.1:${port}`);
});
