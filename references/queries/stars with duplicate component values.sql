--this lists the stars that are duplicates
--browse FCT_Star, filter by SystemID, and fix records by assigning higher Component numbers to higher StarIDs
SELECT
	*
FROM
	FCT_Star as s1
inner JOIN
	FCT_Star as s2
on
	s2.SystemID = s1.SystemID
AND
	s2.Component = s1.Component
AND
	s2.StarID > s1.StarID
order by
	s1.StarID