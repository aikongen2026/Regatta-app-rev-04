# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY tests ./tests
COPY app.js ./app.js

# Copy static frontend assets into the image so they can be served by the
# Node route API. Without copying these files, the server will return
# a 404 for the root path because index.html and related files aren't present.
COPY index.html ./index.html
COPY manifest.webmanifest ./manifest.webmanifest
COPY style.css ./style.css
COPY sw.js ./sw.js
COPY icon-192.png ./icon-192.png
COPY icon-512.png ./icon-512.png

# RUN npm test
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "run", "route-api"]
