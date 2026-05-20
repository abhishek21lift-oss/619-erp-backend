const { z } = require('zod');

const passwordSchema = z.string().min(6, 'Password must be at least 6 characters').max(128);
const emailSchema = z.string().email('Invalid email').max(255).transform(function(v) { return v.toLowerCase().trim(); });
const uuidSchema = z.string().uuid('Invalid ID format');

const authSchemas = {
  login: {
    body: z.object({
      email: emailSchema,
      password: z.string().min(1, 'Password is required'),
    }),
  },
  changePassword: {
    body: z.object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: passwordSchema,
    }),
  },
  createUser: {
    body: z.object({
      name: z.string().min(1, 'Name is required').max(255).transform(function(v) { return v.trim(); }),
      email: emailSchema,
      password: passwordSchema,
      role: z.enum(['admin', 'manager', 'trainer', 'reception', 'member']).default('trainer'),
      trainer_id: uuidSchema.optional().nullable(),
      member_id: uuidSchema.optional().nullable(),
    }),
  },
};

const clientSchemas = {
  create: {
    body: z.object({
      first_name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      last_name: z.string().max(255).optional().default('').transform(function(v) { return v.trim(); }),
      mobile: z.string().min(10).max(20),
      email: emailSchema.optional().nullable(),
      gender: z.enum(['male', 'female', 'other']).optional(),
      dob: z.string().optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      membership_plan_id: uuidSchema.optional().nullable(),
      primary_trainer_id: uuidSchema.optional().nullable(),
    }),
  },
  update: {
    body: z.object({
      first_name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      last_name: z.string().max(255).transform(function(v) { return v.trim(); }).optional(),
      mobile: z.string().min(10).max(20).optional(),
      email: emailSchema.optional().nullable(),
      gender: z.enum(['male', 'female', 'other']).optional(),
      dob: z.string().optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      is_active: z.boolean().optional(),
      primary_trainer_id: uuidSchema.optional().nullable(),
    }),
  },
};

const paymentSchemas = {
  create: {
    body: z.object({
      client_id: uuidSchema,
      amount: z.number().positive('Amount must be positive'),
      payment_mode: z.enum(['cash', 'card', 'upi', 'bank_transfer', 'other']),
      payment_date: z.string().optional(),
      notes: z.string().max(500).optional().nullable(),
      plan_id: uuidSchema.optional().nullable(),
    }),
  },
};

const planSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      duration_days: z.number().int().positive(),
      price: z.number().positive(),
      discount: z.number().min(0).optional().default(0),
      sessions_per_week: z.number().int().min(0).optional().nullable(),
      features: z.string().optional().nullable(),
      is_active: z.boolean().optional().default(true),
    }),
  },
  update: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      duration_days: z.number().int().positive().optional(),
      price: z.number().positive().optional(),
      discount: z.number().min(0).optional(),
      sessions_per_week: z.number().int().min(0).optional().nullable(),
      features: z.string().optional().nullable(),
      is_active: z.boolean().optional(),
    }),
  },
};

const staffSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      email: emailSchema,
      password: passwordSchema,
      role: z.enum(['admin', 'manager', 'trainer', 'reception', 'member']),
      phone: z.string().max(20).optional().nullable(),
      salary: z.number().min(0).optional().nullable(),
      branch_id: uuidSchema.optional().nullable(),
    }),
  },
};

const trainerSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      email: emailSchema,
      phone: z.string().max(20).optional().nullable(),
      specialization: z.string().max(500).optional().nullable(),
      experience_years: z.number().int().min(0).optional().nullable(),
      certification: z.string().max(500).optional().nullable(),
    }),
  },
};

module.exports = {
  authSchemas,
  clientSchemas,
  paymentSchemas,
  planSchemas,
  staffSchemas,
  trainerSchemas,
  z,
};
