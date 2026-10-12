-- Preserve the existing explicit predecessor chain independently of appointments.
WITH RECURSIVE chain(id, depth) AS (
 SELECT id, 0 FROM Tour WHERE previousTourId IS NULL
 UNION ALL SELECT t.id, c.depth + 1 FROM Tour t JOIN chain c ON t.previousTourId=c.id
)
UPDATE Tour SET queueIndex=COALESCE((SELECT depth FROM chain WHERE chain.id=Tour.id),0);
