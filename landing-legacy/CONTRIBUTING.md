# Contributing to zWorkLander

Thank you for your interest in contributing to zWorkLander! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what is best for the community
- Show empathy towards other community members

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Git

### Setting Up Your Development Environment

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/zWorkLander.git
   cd zWorkLander
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```

## Development Workflow

### Branching

- Create a new branch for each feature or bug fix
- Use descriptive branch names:
  - `feature/add-new-component`
  - `fix/animation-bug`
  - `docs/update-readme`

### Making Changes

1. Make your changes following the project's code style
2. Test your changes thoroughly
3. Ensure TypeScript compilation passes: `npm run build`
4. Commit your changes with clear, descriptive messages

### Commit Messages

Follow conventional commit format:
- `feat: add new feature`
- `fix: resolve bug`
- `docs: update documentation`
- `style: format code`
- `refactor: restructure code`
- `test: add tests`
- `chore: update dependencies`

Example:
```
feat: add responsive navigation component

- Implement mobile-friendly navigation
- Add smooth transitions
- Update styling for better UX
```

## Pull Request Process

1. Update documentation if needed
2. Ensure all tests pass
3. Update the README if you've added features
4. Create a pull request with a clear description
5. Link related issues using `#issue-number`

### Pull Request Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
Describe how you tested your changes

## Checklist
- [ ] Code follows project style
- [ ] Self-reviewed the code
- [ ] Commented complex code
- [ ] Updated documentation
- [ ] No new warnings
- [ ] Added tests (if applicable)
```

## Coding Standards

### TypeScript
- Use TypeScript for all new files
- Avoid `any` types when possible
- Use interfaces for object shapes
- Use proper type annotations

### React
- Use functional components with hooks
- Follow React best practices
- Keep components small and focused
- Use proper prop types

### Styling
- Use Tailwind CSS utility classes
- Follow mobile-first responsive design
- Ensure accessibility (ARIA labels, keyboard navigation)

### Code Style
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and single-purpose
- Remove unused code and imports

## Reporting Issues

When reporting issues, please include:
- Clear description of the problem
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots (if applicable)
- Environment details (OS, browser, Node version)

## Questions or Suggestions

For questions or suggestions that don't fit as issues, feel free to:
- Open a discussion on GitHub
- Contact the maintainers

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
