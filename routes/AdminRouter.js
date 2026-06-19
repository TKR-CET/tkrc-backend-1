const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload"); // Assuming you have multer setup separated
const { verifyToken } = require("../middleware/authMiddleware");
const { loginAdmin, addFacultyProfile, getAllFacultyProfiles, getFacultyProfileByLoginId } = require("../controllers/AdminController");

router.post("/login", loginAdmin); // Public
router.post("/addfacultyprofile", verifyToken(["admin"]), upload.single("image"), addFacultyProfile); // Protected
router.get("/facultyprofiles", verifyToken(["admin"]), getAllFacultyProfiles); // Protected
router.get("/facultyprofile/:loginId", verifyToken(["admin"]), getFacultyProfileByLoginId); // Protected

module.exports = router;

