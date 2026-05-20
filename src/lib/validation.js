const { z } = require('zod');

const passwordSchema = z.string().min(6, 'Password must be at least 6 characters').max(128);
const emailSchema = z.string().email('Invalid email').max(255).transform(function(v) { return v.toLowerCase().trim(); });

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
      trainer_id: z.string().optional().nullable(),
      member_id: z.string().optional().nullable(),
    }),
  },
};

const clientSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1, 'Name is required').max(255).transform(function(v) { return v.trim(); }),
      mobile: z.string().max(20).optional().nullable(),
      email: emailSchema.optional().nullable(),
      gender: z.string().max(20).optional().nullable(),
      dob: z.string().optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      trainer_id: z.string().optional().nullable(),
      package_type: z.string().optional().nullable(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      paid_amount: z.number().optional().nullable(),
      joining_date: z.string().optional().nullable(),
      pt_start_date: z.string().optional().nullable(),
      pt_end_date: z.string().optional().nullable(),
      payment_method: z.string().optional().nullable(),
      payment_date: z.string().optional().nullable(),
      weight: z.number().optional().nullable(),
      notes: z.string().max(1000).optional().nullable(),
      status: z.string().optional().nullable(),
      photo_url: z.string().optional().nullable(),
      biometric_code: z.string().optional().nullable(),
      plan_id: z.string().optional().nullable(),
    }).passthrough(),
  },
  update: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      mobile: z.string().max(20).optional().nullable(),
      email: emailSchema.optional().nullable(),
      gender: z.string().max(20).optional().nullable(),
      dob: z.string().optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      trainer_id: z.string().optional().nullable(),
      package_type: z.string().optional().nullable(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      paid_amount: z.number().optional().nullable(),
      status: z.string().optional().nullable(),
      notes: z.string().max(1000).optional().nullable(),
      is_active: z.boolean().optional(),
    }).passthrough(),
  },
};

const paymentSchemas = {
  create: {
    body: z.object({
      client_id: z.string().min(1, 'client_id is required'),
      amount: z.number().positive('Amount must be positive'),
      method: z.string().max(50).optional(),
      date: z.string().optional(),
      payment_mode: z.string().max(50).optional(),
      notes: z.string().max(500).optional().nullable(),
      plan_id: z.string().optional().nullable(),
      trainer_id: z.string().optional().nullable(),
    }).passthrough(),
  },
};

const planSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      kind: z.string().optional(),
      description: z.string().optional().nullable(),
      duration: z.string().optional(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      joining_fee: z.number().optional().nullable(),
      tax_pct: z.number().optional().nullable(),
      sessions_per_week: z.number().optional().nullable(),
      features: z.string().optional().nullable(),
      popular: z.boolean().optional(),
      color: z.string().optional(),
      is_active: z.boolean().optional(),
      status: z.string().optional(),
    }).passthrough(),
  },
  update: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }).optional(),
      kind: z.string().optional(),
      description: z.string().optional().nullable(),
      duration: z.string().optional(),
      base_amount: z.number().optional().nullable(),
      discount: z.number().optional().nullable(),
      final_amount: z.number().optional().nullable(),
      joining_fee: z.number().optional().nullable(),
      tax_pct: z.number().optional().nullable(),
      sessions_per_week: z.number().optional().nullable(),
      features: z.string().optional().nullable(),
      popular: z.boolean().optional(),
      color: z.string().optional(),
      is_active: z.boolean().optional(),
      status: z.string().optional(),
    }).passthrough(),
  },
};

const staffSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      email: emailSchema.optional().nullable(),
      phone: z.string().max(20).optional().nullable(),
      role: z.string().min(1, 'Role is required'),
      status: z.string().optional(),
    }).passthrough(),
  },
};

const trainerSchemas = {
  create: {
    body: z.object({
      name: z.string().min(1).max(255).transform(function(v) { return v.trim(); }),
      mobile: z.string().max(20).optional().nullable(),
      email: emailSchema.optional().nullable(),
      dob: z.string().optional().nullable(),
      gender: z.string().max(20).optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      role: z.string().optional(),
      joining_date: z.string().optional().nullable(),
      salary: z.number().optional().nullable(),
      incentive_rate: z.number().optional().nullable(),
      specialization: z.string().max(500).optional().nullable(),
      certifications: z.string().max(500).optional().nullable(),
      status: z.string().optional(),
      notes: z.string().max(1000).optional().nullable(),
      biometric_code: z.string().optional().nullable(),
    }).passthrough(),
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
