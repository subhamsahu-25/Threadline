import { AppError } from '../lib/errors.js';

export function validate(schemas) {
  return (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (error) {
      if (error?.issues) {
        next(
          new AppError(
            400,
            'validation_error',
            'The request contains invalid fields',
            error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          ),
        );
      } else {
        next(error);
      }
    }
  };
}
