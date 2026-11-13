const { z } = require('zod');

const ApplicationSubmissionSchema = z.object({
  workflowId: z.string().min(1, 'workflowId is required'),
  workflowVersion: z.string().optional(),
  applicant: z.object({
    firstName: z.string().min(1, 'firstName is required'),
    lastName: z.string().min(1, 'lastName is required'),
    nationalId: z.string().min(1, 'nationalId is required'),
    email: z.string().email('Valid email address is required'),
    annualIncome: z.number().positive('annualIncome must be a positive number'),
    requestedAmount: z.number().positive('requestedAmount must be a positive number'),
    loanPurpose: z.string().min(1, 'loanPurpose is required'),
    isSanctioned: z.boolean().default(false)
  })
});

const ManualReviewSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  reviewerId: z.string().min(1, 'reviewerId is required'),
  notes: z.string().min(1, 'notes are required'),
  expectedVersion: z.number().int().optional()
});

module.exports = {
  ApplicationSubmissionSchema,
  ManualReviewSchema
};

