const target = "california";
const buttons = ["Yes", "No"];
const btn = buttons.find(b => b.toLowerCase() === target) || buttons[target === "yes" ? 0 : 1];
console.log(btn);
