import { Client } from "@hashgraph/sdk";
for (const n of ["mainnet", "testnet", "previewnet"]) {
  const c = Client.forName(n);
  console.log(n, "-> ledgerId:", c.ledgerId.toString());
  c.close();
}
try { Client.forName("bogus"); console.log("bogus did NOT throw"); }
catch (e) { console.log("bogus threw:", String(e).slice(0, 120)); }
