FROM node:20-alpine AS build
WORKDIR /app
COPY package.json index.html main.js ./
RUN npm i -g vite && vite build --outDir dist --emptyOutDir

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
