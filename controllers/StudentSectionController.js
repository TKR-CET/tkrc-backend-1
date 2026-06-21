const Year = require("../models/studentSection");
const Faculty = require("../models/facultymodel"); // REQUIRED FOR AUTO-SYNC
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken"); 

// Get students in a section 
const getStudentsBySection = async (req, res) => {
  try {
    const { yearId, departmentId, sectionId } = req.params;

    const year = await Year.findOne({ year: yearId });  
    if (!year) return res.status(404).json({ message: "Year not found" });

    const department = year.departments.find(dept => dept.name === departmentId);  
    if (!department) return res.status(404).json({ message: "Department not found" });

    const section = department.sections.find(sec => sec.name === sectionId);  
    if (!section) return res.status(404).json({ message: "Section not found" });

    res.status(200).json({ students: section.students });
  } catch (error) {
    res.status(500).json({ message: "Error fetching students", error });
  }
};

const getSubjectsByDate = async (req, res) => {
  try {
    const { yearId, departmentId, sectionId, date } = req.params;

    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ message: "Invalid date format. Please use YYYY-MM-DD." });
    }

    const dayOfWeek = targetDate.toLocaleDateString('en-US', { weekday: 'long' });

    const yearData = await Year.findOne({ year: yearId });
    if (!yearData) return res.status(404).json({ message: "Year not found" });

    const deptData = yearData.departments.find(dept => dept.name === departmentId);
    if (!deptData) return res.status(404).json({ message: "Department not found" });

    const sectionData = deptData.sections.find(sec => sec.name === sectionId);
    if (!sectionData) return res.status(404).json({ message: "Section not found" });

    if (!sectionData.timetable || sectionData.timetable.length === 0) {
      return res.status(404).json({ message: "Timetable not found for this section" });
    }

    const daySchedule = sectionData.timetable.find(schedule => schedule.day === dayOfWeek);
    if (!daySchedule) {
      return res.status(404).json({ message: `No timetable found for ${dayOfWeek}` });
    }

    const periodTimings = {
      1: "9:40 - 10:40",
      2: "10:40 - 11:40",
      3: "11:40 - 12:40",
      4: "12:40 - 1:20", // Lunch Break
      5: "1:20 - 2:20",
      6: "2:20 - 3:20",
      7: "3:20 - 4:20"
    };

    const periods = daySchedule.periods
      .filter(period => period.periodNumber !== 4) 
      .map(period => ({
        timing: periodTimings[period.periodNumber] || "Unknown",
        subject: period.subject,
        facultyName: period.facultyName || "Unknown",
        phoneNumber: period.phoneNumber || "N/A"
      }));

    res.status(200).json({
      success: true,
      date,
      day: dayOfWeek,
      periods
    });
  } catch (error) {
    console.error("Error fetching subjects by date:", error.message);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};

// Add multiple students to a section
const addStudentsToSection = async (req, res) => {
  try {
    const { yearId, departmentId, sectionId } = req.params;
    let { students } = req.body;

    if (typeof students === "string") {
      students = JSON.parse(students);
    }

    if (!Array.isArray(students)) {
      return res.status(400).json({ message: "Students must be an array" });
    }

    const year = await Year.findOne({ year: yearId });
    if (!year) return res.status(404).json({ message: "Year not found" });

    const department = year.departments.find((dept) => dept.name === departmentId);
    if (!department) return res.status(404).json({ message: "Department not found" });

    const section = department.sections.find((sec) => sec.name === sectionId);
    if (!section) return res.status(404).json({ message: "Section not found" });

    for (const student of students) {
      const { rollNumber, name, fatherName, password, role, mobileNumber, fatherMobileNumber } = student;

      if (!rollNumber || !name || !password || !mobileNumber) {
        return res.status(400).json({ message: "Each student must have a rollNumber, name, password, and mobile number." });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const imagePath = req.file ? req.file.path : null;

      section.students.push({
        rollNumber,
        name,
        fatherName: fatherName || null,
        password: hashedPassword,
        role: role || "student",
        image: imagePath,
        mobileNumber: String(mobileNumber),  
        fatherMobileNumber: fatherMobileNumber ? String(fatherMobileNumber) : null
      });
    }
    await year.save();
    res.status(201).json({ message: "Students added successfully", section });
  } catch (error) {
    console.error("Error adding students:", error.message);
    res.status(500).json({ message: "Error adding students", error: error.message });
  }
};

// Add or update a timetable for a section and AUTO-SYNC with Faculty
const upsertSectionTimetable = async (req, res) => {
  try {
    const { yearId, departmentId, sectionId } = req.params;
    const timetable = req.body; 

    console.log(`Starting Auto-Sync Timetable for: ${yearId} ${departmentId}-${sectionId}`);

    if (!Array.isArray(timetable)) {
      return res.status(400).json({ message: "Invalid timetable data, expected an array." });
    }

    const yearData = await Year.findOne({ year: yearId });
    if (!yearData) return res.status(404).json({ message: "Year not found" });

    const deptData = yearData.departments.find(dept => dept.name === departmentId);
    if (!deptData) return res.status(404).json({ message: "Department not found" });

    const sectionData = deptData.sections.find(sec => sec.name === sectionId);
    if (!sectionData) return res.status(404).json({ message: "Section not found" });

    // STEP 1: CLEANUP - Remove this section's old periods from ALL faculties
    const faculties = await Faculty.find({});
    for (let faculty of faculties) {
        let modified = false;
        faculty.timetable.forEach(dayObj => {
            const initialLength = dayObj.periods.length;
            dayObj.periods = dayObj.periods.filter(p => 
                !(p.year === yearId && p.department === departmentId && p.section === sectionId)
            );
            if (dayObj.periods.length !== initialLength) modified = true;
        });

        // Remove entirely empty days
        const initialDays = faculty.timetable.length;
        faculty.timetable = faculty.timetable.filter(dayObj => dayObj.periods.length > 0);
        if (faculty.timetable.length !== initialDays) modified = true;

        if (modified) {
            faculty.markModified('timetable'); 
            await faculty.save(); 
        }
    }

    // STEP 2: PROCESS NEW TIMETABLE & ENRICH DATA
    const validatedTimetable = [];
    const facultyUpdates = {}; 

    for (const day of timetable) {
        const validatedDay = { day: day.day, periods: [] };

        for (const period of day.periods || []) {
            let facultyName = "Unknown";
            let phoneNumber = "N/A";
            let facultyId = period.facultyId || null;

            if (facultyId) {
                const assignedFaculty = await Faculty.findOne({ facultyId: facultyId });
                if (assignedFaculty) {
                    facultyName = assignedFaculty.name;
                    phoneNumber = assignedFaculty.phoneNumber;

                    if (!facultyUpdates[facultyId]) facultyUpdates[facultyId] = [];
                    facultyUpdates[facultyId].push({
                        day: day.day,
                        period: {
                            periodNumber: period.periodNumber,
                            subject: period.subject,
                            year: yearId,
                            department: departmentId,
                            section: sectionId
                        }
                    });
                }
            }

            validatedDay.periods.push({
                periodNumber: period.periodNumber,
                subject: period.subject,
                facultyId: facultyId,
                facultyName: facultyName,
                phoneNumber: phoneNumber,
            });
        }
        validatedTimetable.push(validatedDay);
    }

    sectionData.timetable = validatedTimetable;
    yearData.markModified('departments'); 
    await yearData.save();

    // STEP 3: BULLETPROOF MONGOOSE SAVE FOR FACULTY
    for (const fId in facultyUpdates) {
        const facultyToUpdate = await Faculty.findOne({ facultyId: fId });
        
        if (facultyToUpdate) {
            const updatesToAdd = facultyUpdates[fId];

            updatesToAdd.forEach(update => {
                let dayIndex = facultyToUpdate.timetable.findIndex(d => d.day === update.day);
                
                // Using exact Array Indexing to force Mongoose to track changes
                if (dayIndex === -1) {
                    facultyToUpdate.timetable.push({ day: update.day, periods: [update.period] });
                } else {
                    facultyToUpdate.timetable[dayIndex].periods.push(update.period);
                }
            });

            // Sort periods chronologically 
            facultyToUpdate.timetable.forEach(dayEntry => {
                dayEntry.periods.sort((a, b) => a.periodNumber - b.periodNumber);
            });

            facultyToUpdate.markModified('timetable'); // Force save nested array
            await facultyToUpdate.save();
        }
    }

    res.status(200).json({ 
        message: "Timetable updated and auto-synced with faculty successfully!", 
        timetable: sectionData.timetable 
    });

  } catch (error) {
    console.error("Error in upsertSectionTimetable:", error.message);
    res.status(500).json({ message: "Error upserting timetable", error: error.message });
  }
};

// Add a new year
const addYear = async (req, res) => {
  try {
    const { year } = req.body;

    const newYear = new Year({ year, departments: [] });
    await newYear.save();

    res.status(201).json({ message: "Year added successfully", newYear });
  } catch (error) {
    res.status(500).json({ message: "Error adding year", error });
  }
};

// Add a department to a year
const addDepartmentToYear = async (req, res) => {
  try {
    const { yearId } = req.params;  
    const { name } = req.body;  

    const year = await Year.findOne({ year: yearId });  
    if (!year) return res.status(404).json({ message: "Year not found" });

    year.departments.push({ name, sections: [] });
    await year.save();

    res.status(201).json({ message: "Department added successfully", year });
  } catch (error) {
    res.status(500).json({ message: "Error adding department", error });
  }
};

// Add a section to a department
const addSectionToDepartment = async (req, res) => {
  try {
    const { yearId, departmentId } = req.params;  
    const { name } = req.body;  

    const year = await Year.findOne({ year: yearId });  
    if (!year) return res.status(404).json({ message: "Year not found" });

    const department = year.departments.find(dept => dept.name === departmentId);  
    if (!department) return res.status(404).json({ message: "Department not found" });

    department.sections.push({ name, timetable: [], students: [] });
    await year.save();

    res.status(201).json({ message: "Section added successfully", department });
  } catch (error) {
    res.status(500).json({ message: "Error adding section", error });
  }
};

// Login student 
const loginStudent = async (req, res) => {
  try {
    const { rollNumber, password } = req.body;

    if (!rollNumber || !password) {
      return res.status(400).json({
        success: false,
        message: "Roll number and password are required",
      });
    }

    const yearData = await Year.findOne({
      "departments.sections.students.rollNumber": rollNumber,
    });

    if (!yearData) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials: Student not found",
      });
    }

    let student = null;
    let year = null;
    let department = null;
    let section = null;

    for (const dept of yearData.departments) {
      for (const sec of dept.sections) {
        const foundStudent = sec.students.find(
          (stud) => stud.rollNumber === rollNumber
        );
        if (foundStudent) {
          student = foundStudent;
          year = yearData.year;
          department = dept.name;
          section = sec.name;
          break;
        }
      }
      if (student) break;
    }

    if (!student) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials: Student not found",
      });
    }

    const isMatch = await bcrypt.compare(password, student.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials: Incorrect password",
      });
    }

    const token = jwt.sign(
      { 
        id: student._id, 
        role: student.role || "student", 
        rollNumber: student.rollNumber 
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" } 
    );

    res.status(200).json({
      success: true,
      message: "Login successful",
      token, 
      student: {
        id: student._id,
        name: student.name,
        rollNumber: student.rollNumber,
        year,
        department,
        section,
      },
    });
  } catch (error) {
    console.error("Error during student login:", error.message);
    res.status(500).json({
      success: false,
      message: "Error during login",
      error: error.message,
    });
  }
};

// Add timetable to a section
const addTimetable = async (req, res) => {
  try {
    const { year, department, section, timetable } = req.body;

    if (!year || !department || !section || !timetable) {
      return res.status(400).json({ message: "All fields are required" });
    }

    let parsedTimetable;
    try {
      parsedTimetable = JSON.parse(timetable);
      if (!Array.isArray(parsedTimetable) || parsedTimetable.length === 0) {
        return res.status(400).json({ message: "Timetable format is invalid" });
      }
    } catch (error) {
      return res.status(400).json({ message: "Invalid timetable JSON format" });
    }

    const yearData = await Year.findOne({ year });
    if (!yearData) return res.status(404).json({ message: "Year not found" });

    const deptData = yearData.departments.find((dept) => dept.name === department);
    if (!deptData) return res.status(404).json({ message: "Department not found" });

    const sectionData = deptData.sections.find((sec) => sec.name === section);
    if (!sectionData) return res.status(404).json({ message: "Section not found" });

    sectionData.timetable = parsedTimetable;

    await yearData.save();
    res.status(200).json({ message: "Timetable added successfully", timetable: sectionData.timetable });

  } catch (error) {
    console.error("Error in addTimetable:", error.message);
    res.status(500).json({ message: "Error adding timetable", error: error.message });
  }
};

// Delete timetable for a section
const deleteTimetable = async (req, res) => {
  try {
    const { year, department, section } = req.params;

    const yearData = await Year.findOne({ year });
    if (!yearData) return res.status(404).json({ message: "Year not found" });

    const deptData = yearData.departments.find((dept) => dept.name === department);
    if (!deptData) return res.status(404).json({ message: "Department not found" });

    const sectionData = deptData.sections.find((sec) => sec.name === section);
    if (!sectionData) return res.status(404).json({ message: "Section not found" });

    sectionData.timetable = [];

    await yearData.save();
    res.status(200).json({ message: "Timetable deleted successfully" });

  } catch (error) {
    console.error("Error in deleteTimetable:", error.message);
    res.status(500).json({ message: "Error deleting timetable", error: error.message });
  }
};

const getSectionTimetable = async (req, res) => {
  try {
    const { yearId, departmentId, sectionId } = req.params;

    const yearData = await Year.findOne({ year: new RegExp(`^${yearId}$`, "i") });
    if (!yearData) return res.status(404).json({ message: "Year not found" });

    const deptData = yearData.departments.find(dept => dept.name === departmentId);
    if (!deptData) return res.status(404).json({ message: "Department not found" });

    const sectionData = deptData.sections.find(sec => sec.name === sectionId);
    if (!sectionData) return res.status(404).json({ message: "Section not found" });

    res.status(200).json({ timetable: sectionData.timetable });
  } catch (error) {
    console.error("Error fetching timetable:", error.message);
    res.status(500).json({ message: "Error fetching timetable", error: error.message });
  }
};

const getStudentByRollNumber = async (req, res) => {
  try {
    const { rollNumber } = req.params;

    const yearData = await Year.findOne({
      "departments.sections.students.rollNumber": rollNumber,
    });

    if (!yearData) {
      return res.status(404).json({ message: "Student not found" });
    }

    let student = null;
    let year = null;
    let department = null;
    let section = null;

    for (const dept of yearData.departments) {
      for (const sec of dept.sections) {
        const foundStudent = sec.students.find(
          (stud) => stud.rollNumber === rollNumber
        );
        if (foundStudent) {
          student = foundStudent;
          year = yearData.year;
          department = dept.name;
          section = sec.name;
          break;
        }
      }
      if (student) break;
    }

    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    res.status(200).json({
      student: {
        id: student._id,
        name: student.name,
        rollNumber: student.rollNumber,
        fatherName: student.fatherName || null,
        role: student.role,
        year,
        department,
        section,
        image: student.image || null,
        mobileNumber: student.mobileNumber,
        fatherMobileNumber: student.fatherMobileNumber || null,
      },
    });
  } catch (error) {
    console.error("Error fetching student details:", error.message);
    res.status(500).json({ message: "Error fetching student details", error: error.message });
  }
};

// Delete a student from a section by roll number
const deleteStudentByRollNumber = async (req, res) => {
  try {
    const { rollNumber } = req.params;

    const years = await Year.find(); 

    let studentDeleted = false;

    for (const year of years) {
      for (const department of year.departments) {
        for (const section of department.sections) {
          const studentIndex = section.students.findIndex(student => student.rollNumber === rollNumber);

          if (studentIndex !== -1) {
            section.students.splice(studentIndex, 1); 
            await year.save(); 
            studentDeleted = true;
            break;
          }
        }
        if (studentDeleted) break;
      }
      if (studentDeleted) break;
    }

    if (!studentDeleted) {
      return res.status(404).json({ message: "Student not found" });
    }

    res.status(200).json({ message: "Student deleted successfully" });
  } catch (error) {
    console.error("Error deleting student:", error.message);
    res.status(500).json({ message: "Error deleting student", error: error.message });
  }
};

// Delete all students from a section
const deleteAllStudentsInSection = async (req, res) => {
  try {
    const { yearId, departmentId, sectionId } = req.params;

    const year = await Year.findOne({ year: yearId });
    if (!year) return res.status(404).json({ message: "Year not found" });

    const department = year.departments.find((dept) => dept.name === departmentId);
    if (!department) return res.status(404).json({ message: "Department not found" });

    const section = department.sections.find((sec) => sec.name === sectionId);
    if (!section) return res.status(404).json({ message: "Section not found" });

    section.students = []; 
    await year.save();

    res.status(200).json({ message: "All students deleted successfully" });
  } catch (error) {
    console.error("Error deleting all students:", error.message);
    res.status(500).json({ message: "Error deleting all students", error: error.message });
  }
};

module.exports = {
  getStudentsBySection,
  addStudentsToSection,
  upsertSectionTimetable,
  addYear,
  addDepartmentToYear,
  addSectionToDepartment,
  getSubjectsByDate,
  deleteAllStudentsInSection,
  getSectionTimetable,
  deleteStudentByRollNumber,
  getStudentByRollNumber,
  loginStudent,
  addTimetable,
  deleteTimetable
};
