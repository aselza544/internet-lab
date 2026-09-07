import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gatewayRouter from "./gateway";
import webRouter from "./web";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gatewayRouter);
router.use(webRouter);

export default router;
