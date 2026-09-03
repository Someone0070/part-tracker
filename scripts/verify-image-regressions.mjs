import { run } from "./verify-utils.mjs";

run("backend", ["test"]);
run("backend", ["run", "build"]);
run("frontend", ["test"]);
run("frontend", ["run", "build"]);
process.stdout.write("image regression suite verified\n");
