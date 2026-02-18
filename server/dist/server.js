"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const captive_1 = __importDefault(require("./routes/captive"));
const app = (0, express_1.default)();
const PORT = 4000;
app.use(body_parser_1.default.json());
app.use('/', captive_1.default);
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
