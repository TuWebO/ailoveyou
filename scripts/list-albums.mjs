import { smugmugRequest } from "./smugmug-client.mjs";

const me = await smugmugRequest("/api/v2!authuser");
const user = me.Response.User;
console.log(`Authenticated as: ${user.NickName}\n`);

const albumsUri = user.Uris.UserAlbums.Uri;
const albums = await smugmugRequest(`${albumsUri}?count=200`);
for (const album of albums.Response.Album ?? []) {
  console.log(`${album.ImageCount ?? "?"} photos  |  ${album.Name}  |  ${album.WebUri}`);
}
