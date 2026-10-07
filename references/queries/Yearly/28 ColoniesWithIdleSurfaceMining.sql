SELECT
	p.SurfaceMines
	,p.AutoMines
	,*
FROM
	vw_pop as p
left JOIN
	FCT_MineralDeposit as md
on
	md.SystemBodyID = p.SystemBodyID
where
	p.SurfaceMines + p.AutoMines > 0
AND
	md.SystemBodyID is null