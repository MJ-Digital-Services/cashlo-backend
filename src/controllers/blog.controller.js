import { asyncHandler } from '../utils/asyncHandler.js';
import * as blogService from '../services/blog.service.js';
import { revalidateBlogFrontend } from '../utils/revalidateFrontend.js';

export const getAllBlogs = asyncHandler(async (req, res) => {
  const result = await blogService.getAllBlogs(req.query);
  res.status(200).json({ success: true, data: result });
});

export const getBlogBySlug = asyncHandler(async (req, res) => {
  const blog = await blogService.getBlogBySlug(req.params.slug);
  res.status(200).json({ success: true, data: blog });
});

export const getBlogById = asyncHandler(async (req, res) => {
  const blog = await blogService.getBlogById(req.params.id);
  res.status(200).json({ success: true, data: blog });
});

export const createBlog = asyncHandler(async (req, res) => {
  const blog = await blogService.createBlog(req.body, req.user._id);
  revalidateBlogFrontend(blog.slug);
  res.status(201).json({ success: true, message: 'Blog created successfully', data: blog });
});

export const updateBlog = asyncHandler(async (req, res) => {
  const blog = await blogService.updateBlog(req.params.id, req.body);
  revalidateBlogFrontend(blog.slug);
  res.status(200).json({ success: true, message: 'Blog updated successfully', data: blog });
});

export const deleteBlog = asyncHandler(async (req, res) => {
  const blog = await blogService.deleteBlog(req.params.id);
  revalidateBlogFrontend(blog.slug);
  res.status(200).json({ success: true, message: 'Blog deleted successfully' });
});

export const getBlogsGrouped = asyncHandler(async (req, res) => {
  const result = await blogService.getBlogsGroupedByCategory();
  res.status(200).json({ success: true, data: result });
});