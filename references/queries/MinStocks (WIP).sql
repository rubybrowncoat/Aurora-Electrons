SELECT
	min(0,Dur - RsrvDur)
	,*
FROM
	vw_mineralStocks as v